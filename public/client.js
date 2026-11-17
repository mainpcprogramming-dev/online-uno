const socket = io();

let myId = '';
let isHost = false;
let currentGameState = null;
let selectedCardIds = [];
let pendingPlayCardIds = [];

socket.on('connect', () => {
  myId = socket.id;
});

// 画面切り替え関数
function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(screenId).classList.add('active');
}

// 画面上部バナー通知
function showBanner(text, type = 'info') {
  const container = document.getElementById('banner-container');
  const banner = document.createElement('div');
  banner.className = `banner banner-${type}`;
  banner.textContent = text;
  container.appendChild(banner);
  setTimeout(() => banner.remove(), 3500);
}

// --- ホーム画面操作 ---
document.getElementById('btn-create-room').addEventListener('click', () => {
  const playerName = document.getElementById('player-name').value.trim();
  if (!playerName) {
    document.getElementById('home-error').textContent = 'プレイヤー名を入力してください。';
    return;
  }
  socket.emit('createRoom', { playerName });
});

document.getElementById('btn-join-room').addEventListener('click', () => {
  const playerName = document.getElementById('player-name').value.trim();
  const roomCode = document.getElementById('room-code-input').value.trim();
  if (!playerName || roomCode.length !== 4) {
    document.getElementById('home-error').textContent = 'プレイヤー名と4桁の部屋コードを入力してください。';
    return;
  }
  socket.emit('joinRoom', { playerName, roomCode });
});

socket.on('errorMsg', (msg) => {
  document.getElementById('home-error').textContent = msg;
  document.getElementById('lobby-error').textContent = msg;
  showBanner(msg, 'danger');
});

// 部屋入室時（チャットを毎回リセット）
socket.on('roomJoined', ({ roomCode, isHost: hostFlag }) => {
  isHost = hostFlag;
  document.getElementById('home-error').textContent = '';
  document.getElementById('lobby-error').textContent = '';
  document.getElementById('display-room-code').textContent = roomCode;
  document.getElementById('lobby-chat-box').innerHTML = '';
  document.getElementById('game-chat-messages').innerHTML = '';
  document.getElementById('game-log-list').innerHTML = '';

  // ホストなら設定UIとスタートボタンを有効化
  const inputs = document.querySelectorAll('#lobby-screen input[type="range"], #lobby-screen input[type="checkbox"]');
  inputs.forEach(el => el.disabled = !isHost);
  document.getElementById('host-start-controls').classList.toggle('hidden', !isHost);
  document.getElementById('settings-note').textContent = isHost ? '(あなたが変更可能です)' : '(部屋作成者が変更可能)';

  showScreen('lobby-screen');
});

document.getElementById('btn-leave-lobby').addEventListener('click', () => {
  location.reload();
});

// --- 待機室・設定同期 ---
socket.on('lobbyUpdate', ({ players, settings }) => {
  const list = document.getElementById('lobby-player-list');
  list.innerHTML = '';

  players.forEach(p => {
    const li = document.createElement('li');
    li.className = `player-item ${p.isReady ? 'ready-ok' : 'ready-wait'}`;
    const crown = p.isHost ? '👑' : '';
    const statusText = p.isReady ? '準備OK' : '準備中';
    li.innerHTML = `<span>${crown}${escapeHtml(p.name)}</span><span class="status-pill">${statusText}</span>`;
    list.appendChild(li);

    if (p.id === myId) {
      const btnReady = document.getElementById('btn-toggle-ready');
      btnReady.textContent = p.isReady ? '準備OK（解除する）' : '準備OKを押す';
      btnReady.className = p.isReady ? 'btn btn-ready-on' : 'btn btn-ready-off';
    }
  });

  // 設定値の反映
  document.getElementById('set-initial-cards').value = settings.initialCards;
  document.getElementById('val-initial-cards').textContent = settings.initialCards;
  document.getElementById('set-turn-time').value = settings.turnTime;
  document.getElementById('val-turn-time').textContent = settings.turnTime;
  document.getElementById('set-draw-until').checked = settings.drawUntilMatch;
  document.getElementById('set-draw10').checked = settings.draw10;
  document.getElementById('set-no-multi').checked = settings.noMultiPlay;
  document.getElementById('set-stack-draw').checked = settings.stackDraw;
});

function emitSettingsUpdate() {
  if (!isHost) return;
  socket.emit('updateSettings', {
    initialCards: parseInt(document.getElementById('set-initial-cards').value, 10),
    turnTime: parseInt(document.getElementById('set-turn-time').value, 10),
    drawUntilMatch: document.getElementById('set-draw-until').checked,
    draw10: document.getElementById('set-draw10').checked,
    noMultiPlay: document.getElementById('set-no-multi').checked,
    stackDraw: document.getElementById('set-stack-draw').checked
  });
}

['set-initial-cards', 'set-turn-time', 'set-draw-until', 'set-draw10', 'set-no-multi', 'set-stack-draw'].forEach(id => {
  document.getElementById(id).addEventListener('input', emitSettingsUpdate);
});

document.getElementById('btn-toggle-ready').addEventListener('click', () => {
  socket.emit('toggleReady');
});

document.getElementById('btn-start-game').addEventListener('click', () => {
  socket.emit('startGame', { force: false });
});

document.getElementById('btn-force-start').addEventListener('click', () => {
  socket.emit('startGame', { force: true });
});

// --- チャット & ログ ---
document.getElementById('lobby-chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('lobby-chat-input');
  if (input.value.trim()) {
    socket.emit('sendChat', { message: input.value, area: 'lobby' });
    input.value = '';
  }
});

document.getElementById('game-chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('game-chat-input');
  if (input.value.trim()) {
    socket.emit('sendChat', { message: input.value, area: 'game' });
    input.value = '';
  }
});

socket.on('chatMessage', ({ sender, message, area }) => {
  const box = document.getElementById(area === 'lobby' ? 'lobby-chat-box' : 'game-chat-messages');
  const div = document.createElement('div');
  div.className = 'chat-line';
  div.innerHTML = `<strong>${escapeHtml(sender)}:</strong> ${escapeHtml(message)}`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
});

socket.on('gameLog', (msg) => {
  const logList = document.getElementById('game-log-list');
  const div = document.createElement('div');
  div.className = 'log-line';
  div.textContent = msg;
  logList.appendChild(div);
  logList.scrollTop = logList.scrollHeight;
});

// --- カウントダウン & ゲーム開始 ---
socket.on('startCountdown', () => {
  document.getElementById('countdown-overlay').classList.remove('hidden');
});

socket.on('countdownTick', (num) => {
  document.getElementById('countdown-number').textContent = num === 0 ? 'START!' : num;
});

socket.on('gameStarted', () => {
  document.getElementById('countdown-overlay').classList.add('hidden');
  document.getElementById('gameover-modal').classList.add('hidden');
  document.getElementById('game-chat-messages').innerHTML = '';
  document.getElementById('game-log-list').innerHTML = '';
  selectedCardIds = [];
  showScreen('game-screen');
});

// --- ゲーム状態描画 ---
socket.on('timerUpdate', (timeLeft) => {
  document.getElementById('turn-timer').textContent = timeLeft;
});

socket.on('turnBanner', (text) => {
  showBanner(text, 'turn');
});

socket.on('notification', (text) => {
  showBanner(text, 'warning');
});

socket.on('unoDeclaredEffect', (playerName) => {
  showBanner(`🔥 ${playerName} が「UNO！」と宣言しました！`, 'uno');
});

socket.on('accusationResult', ({ success, message }) => {
  showBanner(message, success ? 'success' : 'danger');
});

socket.on('gameStateUpdate', (state) => {
  currentGameState = state;
  renderGame(state);
});

function getCardLabel(value) {
  const map = {
    skip: '⊘',
    reverse: '⇄',
    draw2: '+2',
    wild: '🌈',
    draw4: '+4',
    draw10: '+10'
  };
  return map[value] || value;
}

function createCardElement(card, selectable = false) {
  const div = document.createElement('div');
  div.className = `uno-card card-${card.color}`;
  if (selectable && selectedCardIds.includes(card.id)) {
    div.classList.add('selected');
  }

  const label = getCardLabel(card.value);
  div.innerHTML = `
    <span class="corner-top">${label}</span>
    <div class="card-oval">
      <span class="card-symbol">${label}</span>
    </div>
    <span class="corner-bottom">${label}</span>
  `;

  if (selectable) {
    div.addEventListener('click', () => toggleSelectCard(card));
  }
  return div;
}

function toggleSelectCard(card) {
  if (selectedCardIds.includes(card.id)) {
    selectedCardIds = selectedCardIds.filter(id => id !== card.id);
  } else {
    // 重ね出し禁止の場合、または違う数字を選んだ場合は単一選択に切り替え
    if (currentGameState.settings.noMultiPlay) {
      selectedCardIds = [card.id];
    } else if (selectedCardIds.length > 0) {
      const firstCard = currentGameState.myHand.find(c => c.id === selectedCardIds[0]);
      if (firstCard && firstCard.value === card.value) {
        selectedCardIds.push(card.id);
      } else {
        selectedCardIds = [card.id];
      }
    } else {
      selectedCardIds = [card.id];
    }
  }
  renderGame(currentGameState);
}

function renderGame(state) {
  // 他プレイヤー表示
  const othersContainer = document.getElementById('other-players-bar');
  othersContainer.innerHTML = '';
  state.players.forEach(p => {
    if (p.id === myId) return;
    const badge = document.createElement('div');
    badge.className = `other-player-card ${p.isTurn ? 'active-turn' : ''}`;
    const crown = p.isHost ? '👑' : '';
    const unoTag = p.unoDeclared ? '<span class="uno-tag">UNO!</span>' : '';
    badge.innerHTML = `
      <div class="op-name">${crown}${escapeHtml(p.name)} ${unoTag}</div>
      <div class="op-cards">残り <strong>${p.cardCount}</strong> 枚</div>
    `;
    othersContainer.appendChild(badge);
  });

  // 場札表示
  const discardContainer = document.getElementById('discard-pile');
  discardContainer.innerHTML = '';
  if (state.topCard) {
    discardContainer.appendChild(createCardElement(state.topCard, false));
  }

  // 現在の色インジケーター
  const colorDot = document.getElementById('current-color-indicator');
  colorDot.className = `color-dot bg-${state.currentColor}`;

  // 累積ドロー表示
  const stackBadge = document.getElementById('draw-stack-badge');
  if (state.drawStack > 0) {
    stackBadge.classList.remove('hidden');
    stackBadge.textContent = `累積ドロー: +${state.drawStack}`;
  } else {
    stackBadge.classList.add('hidden');
  }

  // 自分の手札表示
  const handContainer = document.getElementById('my-hand');
  handContainer.innerHTML = '';
  // 存在しない選択IDをクリーンアップ
  selectedCardIds = selectedCardIds.filter(id => state.myHand.some(c => c.id === id));

  state.myHand.forEach(card => {
    handContainer.appendChild(createCardElement(card, true));
  });

  // ボタンの有効/無効制御
  const btnPlay = document.getElementById('btn-play-card');
  btnPlay.disabled = !state.isMyTurn || selectedCardIds.length === 0;

  // UNO宣言は自分のターンのみ押せる
  const btnUno = document.getElementById('btn-uno-declare');
  btnUno.disabled = !state.isMyTurn;
}

// 並び替えボタン（黒カード一番左、その後赤・青・黄・緑の数字順）
document.getElementById('btn-sort-hand').addEventListener('click', () => {
  if (!currentGameState) return;
  const colorOrder = { black: 0, red: 1, blue: 2, yellow: 3, green: 4 };
  const valueOrder = {
    '0': 0, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
    skip: 10, reverse: 11, draw2: 12, wild: 13, draw4: 14, draw10: 15
  };

  currentGameState.myHand.sort((a, b) => {
    if (colorOrder[a.color] !== colorOrder[b.color]) {
      return colorOrder[a.color] - colorOrder[b.color];
    }
    return (valueOrder[a.value] || 99) - (valueOrder[b.value] || 99);
  });
  renderGame(currentGameState);
});

// 山札クリックでカードを引く
document.getElementById('deck-pile').addEventListener('click', () => {
  if (!currentGameState || !currentGameState.isMyTurn) return;
  socket.emit('drawCardAction');
});

// カードを出すボタン
document.getElementById('btn-play-card').addEventListener('click', () => {
  if (!currentGameState || !currentGameState.isMyTurn || selectedCardIds.length === 0) return;
  const firstCard = currentGameState.myHand.find(c => c.id === selectedCardIds[0]);

  if (firstCard && firstCard.color === 'black') {
    pendingPlayCardIds = [...selectedCardIds];
    document.getElementById('color-picker-modal').classList.remove('hidden');
  } else {
    socket.emit('playCards', { cardIds: selectedCardIds, chosenColor: null });
    selectedCardIds = [];
  }
});

// 黒カードの色選択
document.querySelectorAll('.color-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const chosenColor = btn.getAttribute('data-color');
    document.getElementById('color-picker-modal').classList.add('hidden');
    socket.emit('playCards', { cardIds: pendingPlayCardIds, chosenColor });
    selectedCardIds = [];
    pendingPlayCardIds = [];
  });
});

// UNO宣言ボタン
document.getElementById('btn-uno-declare').addEventListener('click', () => {
  if (!currentGameState || !currentGameState.isMyTurn) return;
  socket.emit('declareUno');
});

// UNO告発モーダル表示
document.getElementById('btn-uno-accuse').addEventListener('click', () => {
  if (!currentGameState) return;
  const list = document.getElementById('accuse-player-list');
  list.innerHTML = '';

  currentGameState.players.forEach(p => {
    if (p.id === myId) return;
    const row = document.createElement('div');
    row.className = 'accuse-row';
    row.innerHTML = `
      <span>${p.isHost ? '👑' : ''}${escapeHtml(p.name)} (残り${p.cardCount}枚)</span>
      <button class="btn btn-danger btn-sm">告発する</button>
    `;
    row.querySelector('button').addEventListener('click', () => {
      socket.emit('accuseUno', { targetId: p.id });
      document.getElementById('accuse-modal').classList.add('hidden');
    });
    list.appendChild(row);
  });

  document.getElementById('accuse-modal').classList.remove('hidden');
});

document.getElementById('btn-close-accuse').addEventListener('click', () => {
  document.getElementById('accuse-modal').classList.add('hidden');
});

// ゲーム終了
socket.on('gameOver', ({ winner }) => {
  document.getElementById('winner-text').textContent = `🏆 勝者: ${winner} さん！`;
  document.getElementById('gameover-modal').classList.remove('hidden');
});

document.getElementById('btn-back-to-lobby').addEventListener('click', () => {
  document.getElementById('gameover-modal').classList.add('hidden');
  document.getElementById('lobby-chat-box').innerHTML = '';
  showScreen('lobby-screen');
});

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}