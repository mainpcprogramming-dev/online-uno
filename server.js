const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

function generateRoomCode() {
  let code;
  do {
    code = Math.floor(1000 + Math.random() * 9000).toString();
  } while (rooms[code]);
  return code;
}

function createDeck(settings) {
  const colors = ['red', 'blue', 'yellow', 'green'];
  const deck = [];
  let idCounter = 1;

  colors.forEach(color => {
    deck.push({ id: idCounter++, color, value: '0', type: 'number' });
    const values = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'reverse', 'draw2'];
    values.forEach(val => {
      const type = isNaN(val) ? 'action' : 'number';
      deck.push({ id: idCounter++, color, value: val, type });
      deck.push({ id: idCounter++, color, value: val, type });
    });
  });

  for (let i = 0; i < 4; i++) {
    deck.push({ id: idCounter++, color: 'black', value: 'wild', type: 'wild' });
    deck.push({ id: idCounter++, color: 'black', value: 'draw4', type: 'wild' });
  }

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

function canPlayCard(card, topCard, currentColor, drawStack, settings) {
  if (drawStack > 0) {
    if (!settings.stackDraw) return false;
    if (topCard.value === 'draw2' && (card.value === 'draw2' || card.value === 'draw4' || card.value === 'draw10')) return true;
    if (topCard.value === 'draw4' && (card.value === 'draw4' || card.value === 'draw10')) return true;
    if (topCard.value === 'draw10' && card.value === 'draw10') return true;
    return false;
  }

  if (card.color === 'black') return true;
  if (card.color === currentColor) return true;
  if (card.value === topCard.value) return true;

  return false;
}

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

function handleTurnTimeout(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.state !== 'playing') return;
  if (room.autoDrawTimer) {
    clearInterval(room.autoDrawTimer);
    room.autoDrawTimer = null;
  }

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

function executePlayCards(roomCode, player, selectedCards, chosenColor) {
  const room = rooms[roomCode];
  if (!room || room.state !== 'playing') return;

  const cardIds = selectedCards.map(c => c.id);
  player.hand = player.hand.filter(c => !cardIds.includes(c.id));
  room.discardPile.push(...selectedCards);

  const lastPlayed = selectedCards[selectedCards.length - 1];
  const count = selectedCards.length;

  if (lastPlayed.color === 'black') {
    room.currentColor = chosenColor || 'red';
  } else {
    room.currentColor = lastPlayed.color;
  }

  const colorNames = { red: '赤', blue: '青', yellow: '黄', green: '緑', black: '黒' };
  addLog(roomCode, `🃏 ${player.name} が ${colorNames[lastPlayed.color]}の「${lastPlayed.value}」を ${count}枚 出しました。`);

  if (player.hand.length === 0) {
    clearInterval(room.turnTimer);
    if (room.autoDrawTimer) clearInterval(room.autoDrawTimer);
    room.state = 'lobby';
    room.players.forEach(p => { p.isReady = false; p.hand = []; });
    io.to(roomCode).emit('gameOver', { winner: player.name });
    addLog(roomCode, `🏆 ${player.name} さんの勝利です！`);
    return;
  }

  if (player.hand.length === 1) {
    if (player.unoDeclaredValidUntil >= Date.now()) {
      player.vulnerableUntil = 0;
      player.accused = false;
    } else {
      player.vulnerableUntil = Date.now() + 10000;
      player.accused = false;
    }
  } else {
    player.vulnerableUntil = 0;
    player.accused = false;
  }

  let step = 1;
  const val = lastPlayed.value;

  if (val === 'reverse') {
    if (room.players.length === 2) {
      step = 2;
    } else {
      if (count % 2 === 1) room.direction *= -1;
    }
    addLog(roomCode, `🔁 順番が逆回りになりました！`);
  } else if (val === 'skip') {
    step = 1 + count;
    const skippedIndex = (room.currentTurnIndex + room.direction + room.players.length * 10) % room.players.length;
    const skippedPlayer = room.players[skippedIndex];
    io.to(skippedPlayer.id).emit('notification', 'スキップされました！');
    addLog(roomCode, `⏭️ ${skippedPlayer.name} がスキップされました！`);
  } else if (val === 'draw2') {
    room.drawStack += 2 * count;
    io.to(roomCode).emit('notification', `ドロー${room.drawStack}！`);
  } else if (val === 'draw4') {
    room.drawStack += 4 * count;
    io.to(roomCode).emit('notification', `ドロー${room.drawStack}！`);
  } else if (val === 'draw10') {
    room.drawStack += 10 * count;
    io.to(roomCode).emit('notification', `ドロー${room.drawStack}！`);
  }

  if (room.drawStack > 0 && !room.settings.stackDraw) {
    const targetIndex = (room.currentTurnIndex + room.direction + room.players.length * 10) % room.players.length;
    const targetPlayer = room.players[targetIndex];
    const drawn = drawCardsFromDeck(room, room.drawStack);
    targetPlayer.hand.push(...drawn);
    io.to(targetPlayer.id).emit('notification', `ドロー${room.drawStack}！${room.drawStack}枚引きました`);
    addLog(roomCode, `💥 ${targetPlayer.name} は ${room.drawStack} 枚引いてターンが飛ばされました！`);
    room.drawStack = 0;
    step = 2;
  }

  advanceTurn(roomCode, step);
}

function startStepByStepAutoDraw(roomCode, player) {
  const room = rooms[roomCode];
  if (!room || room.state !== 'playing') return;

  room.isAutoDrawing = true;
  broadcastGameState(roomCode);
  io.to(player.id).emit('notification', '出せるカードがないため1枚ずつ引きます...');

  let drawnCount = 0;
  const maxDraws = room.settings.drawUntilMatch ? 100 : 1;

  room.autoDrawTimer = setInterval(() => {
    if (!rooms[roomCode] || room.state !== 'playing') {
      clearInterval(room.autoDrawTimer);
      room.autoDrawTimer = null;
      return;
    }

    const drawn = drawCardsFromDeck(room, 1);
    if (drawn.length === 0) {
      clearInterval(room.autoDrawTimer);
      room.autoDrawTimer = null;
      room.isAutoDrawing = false;
      addLog(roomCode, `⏭️ 山札がないため ${player.name} のターンを終了します。`);
      advanceTurn(roomCode, 1);
      return;
    }

    const card = drawn[0];
    player.hand.push(card);
    drawnCount++;

    const topCard = room.discardPile[room.discardPile.length - 1];
    const canPlay = canPlayCard(card, topCard, room.currentColor, 0, room.settings);

    broadcastGameState(roomCode);

    if (canPlay) {
      clearInterval(room.autoDrawTimer);
      room.autoDrawTimer = null;
      room.isAutoDrawing = false;
      addLog(roomCode, `📥 ${player.name} は ${drawnCount} 枚目で出せるカードを引きました！`);
      io.to(player.id).emit('notification', '出せるカードを引きました！選択して出してください');
      broadcastGameState(roomCode);
      startTurnTimer(roomCode);
    } else if (drawnCount >= maxDraws) {
      clearInterval(room.autoDrawTimer);
      room.autoDrawTimer = null;
      room.isAutoDrawing = false;
      addLog(roomCode, `📥 ${player.name} は1枚引きましたが、出せるカードがないためターン終了です。`);
      io.to(player.id).emit('notification', '出せるカードが出なかったためターン終了');
      setTimeout(() => advanceTurn(roomCode, 1), 600);
    }
  }, 550);
}

function advanceTurn(roomCode, step = 1) {
  const room = rooms[roomCode];
  if (!room || room.state !== 'playing') return;

  if (room.turnTimer) clearInterval(room.turnTimer);
  if (room.autoDrawTimer) {
    clearInterval(room.autoDrawTimer);
    room.autoDrawTimer = null;
  }
  room.isAutoDrawing = false;

  const numPlayers = room.players.length;
  room.currentTurnIndex = (room.currentTurnIndex + (step * room.direction) + numPlayers * 10) % numPlayers;
  const nextPlayer = room.players[room.currentTurnIndex];

  // 新しいターン開始時にUNO宣言の1ターン1回制限フラグをリセット
  nextPlayer.unoDeclaredThisTurn = false;

  if (nextPlayer.skipNextTurn) {
    nextPlayer.skipNextTurn = false;
    addLog(roomCode, `🚫 ${nextPlayer.name} はUNO告発失敗のペナルティで1回休みです！`);
    io.to(nextPlayer.id).emit('notification', 'スキップされました！（告発失敗ペナルティ）');
    advanceTurn(roomCode, 1);
    return;
  }

  const topCard = room.discardPile[room.discardPile.length - 1];

  if (room.drawStack > 0) {
    const canCounter = nextPlayer.hand.some(c => canPlayCard(c, topCard, room.currentColor, room.drawStack, room.settings));
    if (!canCounter) {
      const drawn = drawCardsFromDeck(room, room.drawStack);
      nextPlayer.hand.push(...drawn);
      io.to(nextPlayer.id).emit('notification', `ドロー${room.drawStack}！出せるカードがないため強制ドローしターン終了`);
      addLog(roomCode, `💥 ${nextPlayer.name} は返せるカードがなく、強制的に ${room.drawStack} 枚引いてターン終了しました。`);
      room.drawStack = 0;
      broadcastGameState(roomCode);
      setTimeout(() => advanceTurn(roomCode, 1), 900);
      return;
    }
  } else {
    const hasPlayable = nextPlayer.hand.some(c => canPlayCard(c, topCard, room.currentColor, 0, room.settings));
    if (!hasPlayable) {
      io.to(roomCode).emit('turnBanner', `${nextPlayer.name}さんの番です`);
      startStepByStepAutoDraw(roomCode, nextPlayer);
      return;
    }
  }

  broadcastGameState(roomCode);
  io.to(roomCode).emit('turnBanner', `${nextPlayer.name}さんの番です`);
  startTurnTimer(roomCode);
}

function addLog(roomCode, message) {
  const room = rooms[roomCode];
  if (!room) return;
  io.to(roomCode).emit('gameLog', message);
}

function broadcastGameState(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  const topCard = room.discardPile[room.discardPile.length - 1];

  room.players.forEach(player => {
    const isMyTurnActive = room.players[room.currentTurnIndex].id === player.id && !room.isAutoDrawing;
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
      isMyTurn: isMyTurnActive,
      canDeclareUno: isMyTurnActive && !player.unoDeclaredThisTurn,
      isAutoDrawing: room.isAutoDrawing,
      settings: room.settings
    });
  });
}

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
  socket.on('createRoom', ({ playerName }) => {
    const code = generateRoomCode();
    const player = {
      id: socket.id,
      name: playerName || 'プレイヤー1',
      isHost: true,
      isReady: false,
      hand: [],
      unoDeclaredValidUntil: 0,
      unoDeclaredThisTurn: false,
      vulnerableUntil: 0,
      accused: false,
      skipNextTurn: false
    };

    rooms[code] = {
      code,
      state: 'lobby',
      players: [player],
      settings: {
        initialCards: 7,
        drawUntilMatch: true,
        draw10: false,
        noMultiPlay: false,
        stackDraw: true,
        turnTime: 30
      },
      deck: [],
      discardPile: [],
      currentColor: 'red',
      currentTurnIndex: 0,
      direction: 1,
      drawStack: 0,
      turnTimer: null,
      autoDrawTimer: null,
      isAutoDrawing: false,
      timeLeft: 30
    };

    socket.join(code);
    socket.roomCode = code;
    socket.emit('roomJoined', { roomCode: code, isHost: true });
    broadcastLobbyState(code);
  });

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
      unoDeclaredThisTurn: false,
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

  socket.on('updateSettings', (newSettings) => {
    const room = rooms[socket.roomCode];
    if (!room || room.state !== 'lobby') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.isHost) return;

    room.settings = { ...room.settings, ...newSettings };
    broadcastLobbyState(socket.roomCode);
  });

  socket.on('toggleReady', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.state !== 'lobby') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    player.isReady = !player.isReady;
    broadcastLobbyState(socket.roomCode);
  });

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

  function initializeGame(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    room.state = 'playing';
    room.deck = createDeck(room.settings);
    room.discardPile = [];
    room.direction = 1;
    room.drawStack = 0;
    room.currentTurnIndex = -1;

    room.players.forEach(p => {
      p.hand = drawCardsFromDeck(room, room.settings.initialCards);
      p.unoDeclaredValidUntil = 0;
      p.unoDeclaredThisTurn = false;
      p.vulnerableUntil = 0;
      p.accused = false;
      p.skipNextTurn = false;
    });

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
    advanceTurn(roomCode, 1);
  }

  // UNO宣言ボタン（自分のターンのみ、1ターンに1回が上限）
  socket.on('declareUno', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.state !== 'playing' || room.isAutoDrawing) return;
    const currentPlayer = room.players[room.currentTurnIndex];
    if (currentPlayer.id !== socket.id) return;

    // すでにこのターンで宣言済みの場合は無視
    if (currentPlayer.unoDeclaredThisTurn) return;

    currentPlayer.unoDeclaredThisTurn = true;
    currentPlayer.unoDeclaredValidUntil = Date.now() + 10000;
    io.to(room.code).emit('unoDeclaredEffect', currentPlayer.name);
    addLog(room.code, `📢 ${currentPlayer.name} が「UNO！」と宣言しました！（10秒間有効）`);
    broadcastGameState(room.code);
  });

  socket.on('accuseUno', ({ targetId }) => {
    const room = rooms[socket.roomCode];
    if (!room || room.state !== 'playing') return;
    const accuser = room.players.find(p => p.id === socket.id);
    const target = room.players.find(p => p.id === targetId);
    if (!accuser || !target || accuser.id === target.id) return;

    const now = Date.now();
    if (target.accused) {
      socket.emit('notification', 'すでに他のプレイヤーが告発を行いました。');
      return;
    }

    if (target.hand.length === 1 && now <= target.vulnerableUntil) {
      target.accused = true;
      const penaltyCards = drawCardsFromDeck(room, 3);
      target.hand.push(...penaltyCards);
      const msg = `${accuser.name}さんが告発に成功しました！${target.name}さんにカード3枚追加！`;
      io.to(room.code).emit('accusationResult', { success: true, message: msg });
      addLog(room.code, `🚨 ${msg}`);
      broadcastGameState(room.code);
    } else {
      accuser.skipNextTurn = true;
      const msg = `${accuser.name}さんが告発に失敗しました！（次のターン1回休み）`;
      io.to(room.code).emit('accusationResult', { success: false, message: msg });
      addLog(room.code, `❌ ${msg}`);
    }
  });

  socket.on('playCards', ({ cardIds, chosenColor }) => {
    const room = rooms[socket.roomCode];
    if (!room || room.state !== 'playing' || room.isAutoDrawing) return;

    const currentPlayer = room.players[room.currentTurnIndex];
    if (currentPlayer.id !== socket.id) return;
    if (!cardIds || cardIds.length === 0) return;

    const selectedCards = [];
    for (const cid of cardIds) {
      const card = currentPlayer.hand.find(c => c.id === cid);
      if (!card) return;
      selectedCards.push(card);
    }

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

    if (!canPlayCard(firstCard, topCard, room.currentColor, room.drawStack, room.settings)) {
      socket.emit('errorMsg', 'そのカードは場に出せません。');
      return;
    }

    executePlayCards(room.code, currentPlayer, selectedCards, chosenColor);
  });

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
        if (room.autoDrawTimer) clearInterval(room.autoDrawTimer);
        delete rooms[code];
        return;
      }

      if (leftPlayer.isHost) {
        room.players[0].isHost = true;
      }

      if (room.state === 'lobby') {
        broadcastLobbyState(code);
      } else if (room.state === 'playing') {
        if (room.players.length === 1) {
          clearInterval(room.turnTimer);
          if (room.autoDrawTimer) clearInterval(room.autoDrawTimer);
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