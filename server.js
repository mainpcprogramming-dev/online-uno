const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

// 4桁のランダムな部屋コード生成
function generateRoomCode() {
  let code;
  do {
    code = Math.floor(1000 + Math.random() * 9000).toString();
  } while (rooms[code]);
  return code;
}

// 山札の生成
function createDeck(settings) {
  const colors = ['red', 'blue', 'yellow', 'green'];
  const deck = [];
  let idCounter = 1;

  colors.forEach(color => {
    // 0は各色1枚
    deck.push({ id: idCounter++, color, value: '0', type: 'number' });
    // 1〜9, skip, reverse, draw2 は各色2枚
    const values = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'reverse', 'draw2'];
    values.forEach(val => {
      const type = isNaN(val) ? 'action' : 'number';
      deck.push({ id: idCounter++, color, value: val, type });
      deck.push({ id: idCounter++, color, value: val, type });
    });
  });

  // 黒カード（ワイルド）: 色変え4枚、ドロー4は4枚固定
  for (let i = 0; i < 4; i++) {
    deck.push({ id: idCounter++, color: 'black', value: 'wild', type: 'wild' });
    deck.push({ id: idCounter++, color: 'black', value: 'draw4', type: 'wild' });
  }

  // ドロー10がオンの場合は2枚固定で追加
  if (settings.draw10) {
    for (let i = 0; i < 2; i++) {
      deck.push({ id: idCounter++, color: 'black', value: 'draw10', type: 'wild' });
    }
  }

  return shuffle(deck);
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// カードを引く（山札が切れたら捨て札をシャッフルして補充）
function drawCardsFromDeck(room, count) {
  const drawn = [];
  for (let i = 0; i < count; i++) {
    if (room.deck.length === 0) {
      if (room.discardPile.length <= 1) break;
      const topCard = room.discardPile.pop();
      room.deck = shuffle(room.discardPile);
      room.discardPile = [topCard];
    }
    drawn.push(room.deck.pop());
  }
  return drawn;
}

// カードが出せるかどうかの判定
function canPlayCard(card, topCard, currentColor, drawStack, settings) {
  // ドロー累積中（ドロー2/4の重複がオンの場合）
  if (drawStack > 0) {
    if (!settings.stackDraw) return false;
    if (topCard.value === 'draw2' && (card.value === 'draw2' || card.value === 'draw4' || card.value === 'draw10')) return true;
    if (topCard.value === 'draw4' && (card.value === 'draw4' || card.value === 'draw10')) return true;
    if (topCard.value === 'draw10' && card.value === 'draw10') return true;
    return false;
  }

  // 黒カードはいつでも使える
  if (card.color === 'black') return true;
  // 現在の場の色と一致
  if (card.color === currentColor) return true;
  // 数字または記号が一致
  if (card.value === topCard.value) return true;

  return false;
}

// ターンタイマーのリセット＆開始
function startTurnTimer(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.state !== 'playing') return;

  if (room.turnTimer) clearInterval(room.turnTimer);
  room.timeLeft = room.settings.turnTime;

  io.to(roomCode).emit('timerUpdate', room.timeLeft);

  room.turnTimer = setInterval(() => {
    room.timeLeft--;
    io.to(roomCode).emit('timerUpdate', room.timeLeft);

    if (room.timeLeft <= 0) {
      clearInterval(room.turnTimer);
      handleTurnTimeout(roomCode);
    }
  }, 1000);
}

// 時間切れ時の自動処理
function handleTurnTimeout(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.state !== 'playing') return;

  const currentPlayer = room.players[room.currentTurnIndex];
  addLog(roomCode, `⏰ ${currentPlayer.name} の制限時間が切れました。`);

  if (room.drawStack > 0) {
    const drawn = drawCardsFromDeck(room, room.drawStack);
    currentPlayer.hand.push(...drawn);
    addLog(roomCode, `${currentPlayer.name} は累積された ${room.drawStack} 枚を引きました。`);
    io.to(currentPlayer.id).emit('notification', `ドロー${room.drawStack}！${room.drawStack}枚引きました`);
    room.drawStack = 0;
  } else {
    const drawn = drawCardsFromDeck(room, 1);
    currentPlayer.hand.push(...drawn);
    addLog(roomCode, `${currentPlayer.name} は山札から1枚引きました。`);
  }

  advanceTurn(roomCode, 1);
}

// 次のターンへ進める
function advanceTurn(roomCode, step = 1) {
  const room = rooms[roomCode];
  if (!room || room.state !== 'playing') return;

  const numPlayers = room.players.length;
  room.currentTurnIndex = (room.currentTurnIndex + (step * room.direction) + numPlayers * 10) % numPlayers;

  const nextPlayer = room.players[room.currentTurnIndex];

  // 告発失敗ペナルティ（1回休み）のチェック
  if (nextPlayer.skipNextTurn) {
    nextPlayer.skipNextTurn = false;
    addLog(roomCode, `🚫 ${nextPlayer.name} はUNO告発失敗のペナルティで1回休みです！`);
    io.to(nextPlayer.id).emit('notification', 'スキップされました！（告発失敗ペナルティ）');
    advanceTurn(roomCode, 1);
    return;
  }

  // 出せるカードがない場合に無限に引くルールのチェック
  if (room.settings.drawUntilMatch && room.drawStack === 0) {
    let hasPlayable = nextPlayer.hand.some(c => canPlayCard(c, room.discardPile[room.discardPile.length - 1], room.currentColor, 0, room.settings));
    let drawnCount = 0;
    while (!hasPlayable && room.deck.length > 0) {
      const drawn = drawCardsFromDeck(room, 1);
      if (drawn.length === 0) break;
      nextPlayer.hand.push(drawn[0]);
      drawnCount++;
      hasPlayable = canPlayCard(drawn[0], room.discardPile[room.discardPile.length - 1], room.currentColor, 0, room.settings);
    }
    if (drawnCount > 0) {
      addLog(roomCode, `🔄 ${nextPlayer.name} は出せるカードが出るまで山札から ${drawnCount} 枚引きました。`);
    }
  }

  broadcastGameState(roomCode);
  io.to(roomCode).emit('turnBanner', `${nextPlayer.name}さんの番です`);
  startTurnTimer(roomCode);
}

// ログ送信
function addLog(roomCode, message) {
  const room = rooms[roomCode];
  if (!room) return;
  io.to(roomCode).emit('gameLog', message);
}

// ゲーム状態の全体配信（手札は本人のみ詳細を送信し、他人は枚数のみ）
function broadcastGameState(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  const topCard = room.discardPile[room.discardPile.length - 1];

  room.players.forEach(player => {
    const publicPlayers = room.players.map((p, idx) => ({
      id: p.id,
      name: p.name,
      isHost: p.isHost,
      cardCount: p.hand.length,
      isTurn: idx === room.currentTurnIndex,
      unoDeclared: p.unoDeclaredValidUntil > Date.now()
    }));

    io.to(player.id).emit('gameStateUpdate', {
      players: publicPlayers,
      myHand: player.hand,
      topCard: topCard,
      currentColor: room.currentColor,
      drawStack: room.drawStack,
      direction: room.direction,
      isMyTurn: room.players[room.currentTurnIndex].id === player.id,
      settings: room.settings
    });
  });
}

// 待機室状態の配信
function broadcastLobbyState(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  io.to(roomCode).emit('lobbyUpdate', {
    roomCode: room.code,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      isHost: p.isHost,
      isReady: p.isReady
    })),
    settings: room.settings
  });
}

io.on('connection', (socket) => {
  // 部屋の作成
  socket.on('createRoom', ({ playerName }) => {
    const code = generateRoomCode();
    const player = {
      id: socket.id,
      name: playerName || 'プレイヤー1',
      isHost: true,
      isReady: false,
      hand: [],
      unoDeclaredValidUntil: 0,
      vulnerableUntil: 0,
      accused: false,
      skipNextTurn: false
    };

    rooms[code] = {
      code,
      state: 'lobby', // lobby, countdown, playing
      players: [player],
      settings: {
        initialCards: 7,
        drawUntilMatch: false,
        draw10: false,
        noMultiPlay: false, // 重ね出し禁止（trueなら1枚ずつ）
        stackDraw: true,    // ドロー2・4の重複
        turnTime: 30
      },
      deck: [],
      discardPile: [],
      currentColor: 'red',
      currentTurnIndex: 0,
      direction: 1,
      drawStack: 0,
      turnTimer: null,
      timeLeft: 30
    };

    socket.join(code);
    socket.roomCode = code;
    socket.emit('roomJoined', { roomCode: code, isHost: true });
    broadcastLobbyState(code);
  });

  // 部屋の参加
  socket.on('joinRoom', ({ playerName, roomCode }) => {
    const room = rooms[roomCode];
    if (!room) {
      socket.emit('errorMsg', '指定された部屋コードが見つかりません。');
      return;
    }
    if (room.state !== 'lobby') {
      socket.emit('errorMsg', 'この部屋はすでにゲームが開始されています。');
      return;
    }
    if (room.players.length >= 10) {
      socket.emit('errorMsg', '部屋が満員です。');
      return;
    }

    const player = {
      id: socket.id,
      name: playerName || `プレイヤー${room.players.length + 1}`,
      isHost: false,
      isReady: false,
      hand: [],
      unoDeclaredValidUntil: 0,
      vulnerableUntil: 0,
      accused: false,
      skipNextTurn: false
    };

    room.players.push(player);
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.emit('roomJoined', { roomCode, isHost: false });
    broadcastLobbyState(roomCode);
  });

  // ルール設定の変更（ホストのみ）
  socket.on('updateSettings', (newSettings) => {
    const room = rooms[socket.roomCode];
    if (!room || room.state !== 'lobby') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.isHost) return;

    room.settings = { ...room.settings, ...newSettings };
    broadcastLobbyState(socket.roomCode);
  });

  // 準備OKの切り替え
  socket.on('toggleReady', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.state !== 'lobby') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    player.isReady = !player.isReady;
    broadcastLobbyState(socket.roomCode);
  });

  // チャット送信（待機室・ゲーム中共通）
  socket.on('sendChat', ({ message, area }) => {
    const room = rooms[socket.roomCode];
    if (!room || !message.trim()) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    const displayName = player.isHost ? `👑${player.name}` : player.name;
    io.to(socket.roomCode).emit('chatMessage', {
      sender: displayName,
      message: message.trim(),
      area
    });
  });

  // ゲーム開始（ホストのみ・強制スタート対応）
  socket.on('startGame', ({ force }) => {
    const room = rooms[socket.roomCode];
    if (!room || room.state !== 'lobby') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.isHost) return;

    if (room.players.length < 2) {
      socket.emit('errorMsg', '2人以上のプレイヤーが必要です。');
      return;
    }

    const allReady = room.players.every(p => p.isReady);
    if (!allReady && !force) {
      socket.emit('errorMsg', '全員が準備OKを押していません（強制スタートは可能です）。');
      return;
    }

    room.state = 'countdown';
    io.to(room.code).emit('startCountdown');

    let count = 3;
    const cdInterval = setInterval(() => {
      io.to(room.code).emit('countdownTick', count);
      count--;
      if (count < 0) {
        clearInterval(cdInterval);
        initializeGame(room.code);
      }
    }, 1000);
  });

  // ゲーム初期化・カード配布
  function initializeGame(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    room.state = 'playing';
    room.deck = createDeck(room.settings);
    room.discardPile = [];
    room.direction = 1;
    room.drawStack = 0;
    room.currentTurnIndex = 0;

    // 各プレイヤーに初期枚数を配布
    room.players.forEach(p => {
      p.hand = drawCardsFromDeck(room, room.settings.initialCards);
      p.unoDeclaredValidUntil = 0;
      p.vulnerableUntil = 0;
      p.accused = false;
      p.skipNextTurn = false;
    });

    // 最初の場札（数字カードになるまで引き直す）
    let firstCard = drawCardsFromDeck(room, 1)[0];
    while (firstCard.color === 'black' || firstCard.type === 'action') {
      room.deck.unshift(firstCard);
      room.deck = shuffle(room.deck);
      firstCard = drawCardsFromDeck(room, 1)[0];
    }
    room.discardPile.push(firstCard);
    room.currentColor = firstCard.color;

    io.to(roomCode).emit('gameStarted');
    addLog(roomCode, '🎮 ゲームが開始されました！');
    broadcastGameState(roomCode);
    io.to(roomCode).emit('turnBanner', `${room.players[0].name}さんの番です`);
    startTurnTimer(roomCode);
  }

  // UNO宣言ボタン（自分のターンのみ、押してから10秒間有効）
  socket.on('declareUno', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.state !== 'playing') return;
    const currentPlayer = room.players[room.currentTurnIndex];
    if (currentPlayer.id !== socket.id) return;

    currentPlayer.unoDeclaredValidUntil = Date.now() + 10000;
    io.to(room.code).emit('unoDeclaredEffect', currentPlayer.name);
    addLog(room.code, `📢 ${currentPlayer.name} が「UNO！」と宣言しました！（10秒間有効）`);
    broadcastGameState(room.code);
  });

  // UNO告発ボタン
  socket.on('accuseUno', ({ targetId }) => {
    const room = rooms[socket.roomCode];
    if (!room || room.state !== 'playing') return;
    const accuser = room.players.find(p => p.id === socket.id);
    const target = room.players.find(p => p.id === targetId);
    if (!accuser || !target || accuser.id === target.id) return;

    const now = Date.now();
    // すでに誰かが告発済みなら最初の一人のみ有効
    if (target.accused) {
      socket.emit('notification', 'すでに他のプレイヤーが告発を行いました。');
      return;
    }

    // 対象が残り1枚で、かつ10秒以内の告発可能時間内で、UNO宣言をしていない場合 -> 告発成功
    if (target.hand.length === 1 && now <= target.vulnerableUntil) {
      target.accused = true;
      const penaltyCards = drawCardsFromDeck(room, 3);
      target.hand.push(...penaltyCards);
      const msg = `${accuser.name}さんが告発に成功しました！${target.name}さんにカード3枚追加！`;
      io.to(room.code).emit('accusationResult', { success: true, message: msg });
      addLog(room.code, `🚨 ${msg}`);
      broadcastGameState(room.code);
    } else {
      // 告発失敗 -> 告発者が次のターン1回休み
      accuser.skipNextTurn = true;
      const msg = `${accuser.name}さんが告発に失敗しました！（次のターン1回休み）`;
      io.to(room.code).emit('accusationResult', { success: false, message: msg });
      addLog(room.code, `❌ ${msg}`);
    }
  });

  // カードを出す処理
  socket.on('playCards', ({ cardIds, chosenColor }) => {
    const room = rooms[socket.roomCode];
    if (!room || room.state !== 'playing') return;

    const currentPlayer = room.players[room.currentTurnIndex];
    if (currentPlayer.id !== socket.id) return;
    if (!cardIds || cardIds.length === 0) return;

    // 選択されたカードを抽出
    const selectedCards = [];
    for (const cid of cardIds) {
      const card = currentPlayer.hand.find(c => c.id === cid);
      if (!card) return;
      selectedCards.push(card);
    }

    // 重ね出しチェック
    if (selectedCards.length > 1) {
      if (room.settings.noMultiPlay) {
        socket.emit('errorMsg', '現在のルールではカードの重ね出しは禁止されています。');
        return;
      }
      const firstVal = selectedCards[0].value;
      if (!selectedCards.every(c => c.value === firstVal)) {
        socket.emit('errorMsg', '重ね出しは同じ数字（または同じ記号）のカードのみ可能です。');
        return;
      }
    }

    const topCard = room.discardPile[room.discardPile.length - 1];
    const firstCard = selectedCards[0];

    // 1枚目が出せるカードか判定
    if (!canPlayCard(firstCard, topCard, room.currentColor, room.drawStack, room.settings)) {
      socket.emit('errorMsg', 'そのカードは場に出せません。');
      return;
    }

    // 手札から削除して場に出す
    currentPlayer.hand = currentPlayer.hand.filter(c => !cardIds.includes(c.id));
    room.discardPile.push(...selectedCards);

    const lastPlayed = selectedCards[selectedCards.length - 1];
    const count = selectedCards.length;

    // 色の更新
    if (lastPlayed.color === 'black') {
      room.currentColor = chosenColor || 'red';
    } else {
      room.currentColor = lastPlayed.color;
    }

    const colorNames = { red: '赤', blue: '青', yellow: '黄', green: '緑', black: '黒' };
    addLog(room.code, `🃏 ${currentPlayer.name} が ${colorNames[lastPlayed.color]}の「${lastPlayed.value}」を ${count}枚 出しました。`);

    // 勝利判定（手札0枚）
    if (currentPlayer.hand.length === 0) {
      clearInterval(room.turnTimer);
      room.state = 'lobby';
      // 全員の準備状態をリセット
      room.players.forEach(p => { p.isReady = false; p.hand = []; });
      io.to(room.code).emit('gameOver', { winner: currentPlayer.name });
      addLog(room.code, `🏆 ${currentPlayer.name} さんの勝利です！`);
      return;
    }

    // 残り1枚になった時のUNO宣言チェック
    if (currentPlayer.hand.length === 1) {
      if (currentPlayer.unoDeclaredValidUntil >= Date.now()) {
        // 宣言済み（10秒以内）
        currentPlayer.vulnerableUntil = 0;
        currentPlayer.accused = false;
      } else {
        // 宣言忘れ -> 10秒間告発可能状態にする
        currentPlayer.vulnerableUntil = Date.now() + 10000;
        currentPlayer.accused = false;
      }
    } else {
      currentPlayer.vulnerableUntil = 0;
      currentPlayer.accused = false;
    }

    // 特殊カードの効果処理
    let step = 1;
    const val = lastPlayed.value;

    if (val === 'reverse') {
      if (room.players.length === 2) {
        step = 2; // 2人プレイ時のリバースはスキップと同じ
      } else {
        if (count % 2 === 1) room.direction *= -1;
      }
      addLog(room.code, `🔁 順番が逆回りになりました！`);
    } else if (val === 'skip') {
      step = 1 + count;
      const skippedIndex = (room.currentTurnIndex + room.direction + room.players.length * 10) % room.players.length;
      const skippedPlayer = room.players[skippedIndex];
      io.to(skippedPlayer.id).emit('notification', 'スキップされました！');
      addLog(room.code, `⏭️ ${skippedPlayer.name} がスキップされました！`);
    } else if (val === 'draw2') {
      room.drawStack += 2 * count;
      io.to(room.code).emit('notification', `ドロー${room.drawStack}！`);
    } else if (val === 'draw4') {
      room.drawStack += 4 * count;
      io.to(room.code).emit('notification', `ドロー${room.drawStack}！`);
    } else if (val === 'draw10') {
      room.drawStack += 10 * count;
      io.to(room.code).emit('notification', `ドロー${room.drawStack}！`);
    }

    // ドロー重複がオフの場合、即座に次のプレイヤーに引かせてスキップ
    if (room.drawStack > 0 && !room.settings.stackDraw) {
      const targetIndex = (room.currentTurnIndex + room.direction + room.players.length * 10) % room.players.length;
      const targetPlayer = room.players[targetIndex];
      const drawn = drawCardsFromDeck(room, room.drawStack);
      targetPlayer.hand.push(...drawn);
      io.to(targetPlayer.id).emit('notification', `ドロー${room.drawStack}！${room.drawStack}枚引きました`);
      addLog(room.code, `💥 ${targetPlayer.name} は ${room.drawStack} 枚引いてターンが飛ばされました！`);
      room.drawStack = 0;
      step = 2;
    }

    advanceTurn(room.code, step);
  });

  // 山札からカードを引く（プレイヤーの操作）
  socket.on('drawCardAction', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.state !== 'playing') return;

    const currentPlayer = room.players[room.currentTurnIndex];
    if (currentPlayer.id !== socket.id) return;

    // ドロー累積中の場合は累積分を引いてターン終了
    if (room.drawStack > 0) {
      const drawn = drawCardsFromDeck(room, room.drawStack);
      currentPlayer.hand.push(...drawn);
      io.to(currentPlayer.id).emit('notification', `ドロー${room.drawStack}！${room.drawStack}枚引きました`);
      addLog(room.code, `💥 ${currentPlayer.name} は累積された ${room.drawStack} 枚を引きました。`);
      room.drawStack = 0;
      advanceTurn(room.code, 1);
      return;
    }

    // 出せるカードがあるか確認
    const topCard = room.discardPile[room.discardPile.length - 1];
    const hasPlayable = currentPlayer.hand.some(c => canPlayCard(c, topCard, room.currentColor, 0, room.settings));
    if (hasPlayable) {
      socket.emit('errorMsg', '出せるカードが手札にあります。');
      return;
    }

    // 出せるカードが出るまで無限に引く
    let drawnCount = 0;
    let foundPlayable = false;
    while (!foundPlayable && room.deck.length > 0) {
      const drawn = drawCardsFromDeck(room, 1);
      if (drawn.length === 0) break;
      currentPlayer.hand.push(drawn[0]);
      drawnCount++;
      if (canPlayCard(drawn[0], topCard, room.currentColor, 0, room.settings)) {
        foundPlayable = true;
      }
    }

    addLog(room.code, `📥 ${currentPlayer.name} は出せるカードが出るまで山札から ${drawnCount} 枚引きました。`);
    broadcastGameState(room.code);
  });

  // 切断処理
  socket.on('disconnect', () => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room) return;

    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx !== -1) {
      const leftPlayer = room.players[idx];
      room.players.splice(idx, 1);
      addLog(code, `🚪 ${leftPlayer.name} が退出しました。`);

      if (room.players.length === 0) {
        if (room.turnTimer) clearInterval(room.turnTimer);
        delete rooms[code];
        return;
      }

      // ホストが抜けた場合は次の人に👑を移譲
      if (leftPlayer.isHost) {
        room.players[0].isHost = true;
      }

      if (room.state === 'lobby') {
        broadcastLobbyState(code);
      } else if (room.state === 'playing') {
        if (room.players.length === 1) {
          clearInterval(room.turnTimer);
          room.state = 'lobby';
          room.players[0].isReady = false;
          io.to(code).emit('gameOver', { winner: room.players[0].name });
        } else {
          if (room.currentTurnIndex >= room.players.length) {
            room.currentTurnIndex = 0;
          }
          broadcastGameState(code);
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});