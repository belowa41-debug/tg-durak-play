const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ['websocket', 'polling']
});

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
app.use(express.static(__dirname));

const SUITS = [
    { id: 'spades', symbol: '♠', color: 'black' },
    { id: 'clubs', symbol: '♣', color: 'black' },
    { id: 'hearts', symbol: '♥', color: 'red' },
    { id: 'diamonds', symbol: '♦', color: 'red' }
];
const VALUES = [
    { name: '6', strength: 6 }, { name: '7', strength: 7 }, { name: '8', strength: 8 },
    { name: '9', strength: 9 }, { name: '10', strength: 10 }, { name: 'J', strength: 11 },
    { name: 'Q', strength: 12 }, { name: 'K', strength: 13 }, { name: 'A', strength: 14 }
];

let rooms = {};
let randomQueue = [];

io.on('connection', (socket) => {
    socket.on('joinRoom', (roomId) => {
        roomId = sanitizeRoomId(roomId);
        if (!roomId) return;

        leaveRandomQueue(socket.id);
        joinGameRoom(socket, roomId);
    });

    socket.on('findRandomGame', () => {
        let currentRoomId = getPlayerRoom(socket.id);
        if (currentRoomId && rooms[currentRoomId]) {
            if (rooms[currentRoomId].state === "PLAYING") {
                updateRoom(currentRoomId);
                return;
            }

            removePlayerFromRoom(currentRoomId, socket.id);
        }

        leaveRandomQueue(socket.id);

        const opponentId = randomQueue.find(id => id !== socket.id && io.sockets.sockets.get(id));
        if (!opponentId) {
            randomQueue.push(socket.id);
            socket.emit('status', "Ищем случайного соперника...");
            return;
        }

        leaveRandomQueue(opponentId);
        const opponentSocket = io.sockets.sockets.get(opponentId);
        const roomId = createRandomRoomId();

        joinGameRoom(opponentSocket, roomId);
        joinGameRoom(socket, roomId);
    });

    socket.on('playCard', (cardIdx) => {
        let roomId = getPlayerRoom(socket.id);
        if (!roomId) return;
        let room = rooms[roomId];
        if (room.state !== "PLAYING") return;

        let playerIdx = room.players.findIndex(p => p.id === socket.id);
        let defenderIdx = room.attackerIdx === 0 ? 1 : 0;
        let player = room.players[playerIdx];
        
        if (cardIdx < 0 || cardIdx >= player.hand.length) return;
        let card = player.hand[cardIdx];

        // 1. ЛОГИКА НАПАДАЮЩЕГО (Атака и Подкидывание)
        if (playerIdx === room.attackerIdx) {
            // Первый ход в раунде — можно ходить любой картой
            if (room.table.length === 0) {
                player.hand.splice(cardIdx, 1);
                room.table.push({ attack: card, defense: null });
                resetRoomTimer(room, roomId);
                updateRoom(roomId);
            } 
            // Подкидывание — на столе уже что-то есть
            else {
                // Собираем ВСЕ номиналы карт, которые уже есть на столе (и в атаке, и в защите)
                let valuesOnTable = [];
                room.table.forEach(pair => {
                    valuesOnTable.push(pair.attack.value.name);
                    if (pair.defense) valuesOnTable.push(pair.defense.value.name);
                });

                // Если номинал карты из руки совпадает с любой картой на столе — подкидываем!
                if (valuesOnTable.includes(card.value.name)) {
                    player.hand.splice(cardIdx, 1);
                    room.table.push({ attack: card, defense: null });
                    resetRoomTimer(room, roomId);
                    updateRoom(roomId);
                }
            }
        } 
        // 2. ЛОГИКА ЗАЩИЩАЮЩЕГОСЯ
        else if (playerIdx === defenderIdx) {
            // Ищем первую непобитую карту на столе
            let pairToBeat = room.table.find(pair => pair.defense === null);
            if (!pairToBeat) return;

            if (canBeat(pairToBeat.attack, card, room.trump.suit.id)) {
                player.hand.splice(cardIdx, 1);
                pairToBeat.defense = card;
                resetRoomTimer(room, roomId);
                checkWin(roomId);
                updateRoom(roomId);
            }
        }
    });

    socket.on('actionButton', () => {
        let roomId = getPlayerRoom(socket.id);
        if (!roomId) return;
        let room = rooms[roomId];
        if (room.state !== "PLAYING") return;

        let playerIdx = room.players.findIndex(p => p.id === socket.id);
        let defenderIdx = room.attackerIdx === 0 ? 1 : 0;

        // Нападающий жмет БИТО
        if (playerIdx === room.attackerIdx && room.table.length > 0) {
            let allBeaten = room.table.every(pair => pair.defense !== null);
            if (allBeaten) {
                room.table = [];
                drawCards(room);
                room.attackerIdx = defenderIdx; // Ход переходит к защитнику
                resetRoomTimer(room, roomId);
                checkWin(roomId);
                updateRoom(roomId);
            }
        } 
        // Защитник жмет ВЗЯТЬ
        else if (playerIdx === defenderIdx && room.table.length > 0) {
            let defender = room.players[defenderIdx];
            room.table.forEach(pair => {
                defender.hand.push(pair.attack);
                if (pair.defense) defender.hand.push(pair.defense);
            });
            room.table = [];
            drawCards(room);
            // Так как защитник взял карты, право атаки ОСТАЕТСЯ у прежнего нападающего
            resetRoomTimer(room, roomId);
            checkWin(roomId);
            updateRoom(roomId);
        }
    });

    socket.on('disconnect', () => {
        leaveRandomQueue(socket.id);
        let roomId = getPlayerRoom(socket.id);
        if (roomId && rooms[roomId]) {
            clearInterval(rooms[roomId].timer);
            io.to(roomId).emit('status', "Соперник отключился.");
            delete rooms[roomId];
        }
    });
});

function sanitizeRoomId(roomId) {
    return String(roomId || '').replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 64);
}

function createRandomRoomId() {
    return `random-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

function leaveRandomQueue(socketId) {
    randomQueue = randomQueue.filter(id => id !== socketId && io.sockets.sockets.get(id));
}

function removePlayerFromRoom(roomId, socketId) {
    let room = rooms[roomId];
    if (!room) return;

    room.players = room.players.filter(player => player.id !== socketId);
    io.sockets.sockets.get(socketId)?.leave(roomId);

    if (room.players.length === 0 || room.state === "WAITING") {
        clearInterval(room.timer);
        delete rooms[roomId];
    }
}

function joinGameRoom(socket, roomId) {
    if (!socket) return;

    socket.join(roomId);
    if (!rooms[roomId]) {
        rooms[roomId] = { players: [], deck: [], trump: null, table: [], attackerIdx: 0, state: "WAITING", timer: null, timeLeft: 60, activeTurnPlayerId: null };
    }

    let room = rooms[roomId];
    if (room.players.length < 2 && !room.players.some(p => p.id === socket.id)) {
        room.players.push({ id: socket.id, hand: [], name: `Игрок ${room.players.length + 1}` });
    }

    if (room.players.length === 2 && room.state === "WAITING") {
        initGame(room, roomId);
    } else if (room.state === "WAITING") {
        socket.emit('status', "Ожидаем второго игрока...");
    }

    updateRoom(roomId);
}

function canBeat(attack, defense, trumpSuitId) {
    if (attack.suit.id === defense.suit.id) {
        return defense.value.strength > attack.value.strength;
    }
    if (attack.suit.id !== trumpSuitId && defense.suit.id === trumpSuitId) {
        return true;
    }
    return false;
}

function initGame(room, roomId) {
    room.state = "PLAYING";
    room.deck = [];
    for (let suit of SUITS) {
        for (let val of VALUES) {
            room.deck.push({ suit, value: val });
        }
    }
    room.deck.sort(() => Math.random() - 0.5);
    
    for (let player of room.players) {
        player.hand = room.deck.splice(0, 6);
    }
    room.trump = room.deck[room.deck.length - 1];

    let lowestTrumpIdx = 0;
    let lowestTrumpStrength = 99;
    room.players.forEach((player, pIdx) => {
        player.hand.forEach(card => {
            if (card.suit.id === room.trump.suit.id && card.value.strength < lowestTrumpStrength) {
                lowestTrumpStrength = card.value.strength;
                lowestTrumpIdx = pIdx;
            }
        });
    });
    room.attackerIdx = lowestTrumpIdx;
    
    resetRoomTimer(room, roomId);
}

function resetRoomTimer(room, roomId) {
    if (room.timer) clearInterval(room.timer);
    
    room.timeLeft = 60;
    let defenderIdx = room.attackerIdx === 0 ? 1 : 0;
    let activeIdx = (room.table.length === 0 || room.table[room.table.length - 1].defense !== null) ? room.attackerIdx : defenderIdx;
    room.activeTurnPlayerId = room.players[activeIdx].id;

    room.timer = setInterval(() => {
        room.timeLeft--;
        if (room.timeLeft <= 0) {
            clearInterval(room.timer);
            room.state = "ENDED";
            let winner = room.players.find(p => p.id !== room.activeTurnPlayerId);
            io.to(roomId).emit('gameOver', { winner: winner ? winner.id : 'draw', reason: 'timeout' });
        } else {
            io.to(roomId).emit('timerUpdate', { timeLeft: room.timeLeft, activeId: room.activeTurnPlayerId });
        }
    }, 1000);
}

function drawCards(room) {
    for (let i = 0; i < 2; i++) {
        let p = room.players[(room.attackerIdx + i) % 2];
        while (p.hand.length < 6 && room.deck.length > 0) {
            p.hand.push(room.deck.splice(0, 1)[0]);
        }
    }
}

function checkWin(roomId) {
    let room = rooms[roomId];
    if (room.deck.length === 0) {
        let p1 = room.players[0];
        let p2 = room.players[1];
        if (p1.hand.length === 0 && p2.hand.length === 0) {
            clearInterval(room.timer); room.state = "ENDED"; io.to(roomId).emit('gameOver', { winner: 'draw' });
        } else if (p1.hand.length === 0) {
            clearInterval(room.timer); room.state = "ENDED"; io.to(roomId).emit('gameOver', { winner: p1.id });
        } else if (p2.hand.length === 0) {
            clearInterval(room.timer); room.state = "ENDED"; io.to(roomId).emit('gameOver', { winner: p2.id });
        }
    }
}

function updateRoom(roomId) {
    let room = rooms[roomId];
    if (!room || room.state !== "PLAYING") return;
    
    room.players.forEach((player, idx) => {
        let enemy = room.players[(idx + 1) % 2];
        let defenderIdx = room.attackerIdx === 0 ? 1 : 0;
        let activeIdx = (room.table.length === 0 || room.table[room.table.length - 1].defense !== null) ? room.attackerIdx : defenderIdx;
        
        io.to(player.id).emit('gameState', {
            myHand: player.hand,
            enemyCardCount: enemy ? enemy.hand.length : 0,
            table: room.table,
            trump: room.trump,
            isAttacker: (idx === room.attackerIdx),
            isMyActiveTurn: (idx === activeIdx),
            deckCount: room.deck.length,
            gameState: room.state
        });
    });
}

function getPlayerRoom(socketId) {
    for (let rId in rooms) {
        if (rooms[rId].players.some(p => p.id === socketId)) return rId;
    }
    return null;
}

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => console.log(`Сервер запущен на порту ${PORT}`));
