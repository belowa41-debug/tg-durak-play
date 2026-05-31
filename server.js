const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    transports: ['websocket', 'polling']
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

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

io.on('connection', (socket) => {
    socket.on('joinRoom', (roomId) => {
        socket.join(roomId);
        if (!rooms[roomId]) {
            rooms[roomId] = { players: [], deck: [], trump: null, table: [], turn: 0, state: "WAITING" };
        }
        let room = rooms[roomId];
        if (room.players.length < 2 && !room.players.some(p => p.id === socket.id)) {
            room.players.push({ id: socket.id, hand: [], name: `Игрок ${room.players.length + 1}` });
        }
        if (room.players.length === 2 && room.state === "WAITING") {
            initGame(room);
        } else {
            socket.emit('status', "Ожидаем второго игрока...");
        }
        updateRoom(roomId);
    });

    socket.on('playCard', (cardIdx) => {
        let roomId = getPlayerRoom(socket.id);
        if (!roomId) return;
        let room = rooms[roomId];
        let playerIdx = room.players.findIndex(p => p.id === socket.id);
        if (playerIdx !== room.turn || room.state !== "PLAYING") return;
        let player = room.players[playerIdx];
        if (cardIdx >= 0 && cardIdx < player.hand.length) {
            let card = player.hand.splice(cardIdx, 1)[0];
            room.table.push(card);
            room.turn = (room.turn + 1) % 2;
            checkWin(roomId);
            updateRoom(roomId);
        }
    });

    socket.on('actionButton', () => {
        let roomId = getPlayerRoom(socket.id);
        if (!roomId) return;
        let room = rooms[roomId];
        if (room.state !== "PLAYING") return;
        room.table = [];
        room.turn = (room.turn + 1) % 2;
        updateRoom(roomId);
    });

    socket.on('disconnect', () => {
        let roomId = getPlayerRoom(socket.id);
        if (roomId && rooms[roomId]) {
            io.to(roomId).emit('status', "Соперник отключился.");
            delete rooms[roomId];
        }
    });
});

function initGame(room) {
    room.state = "PLAYING";
    room.deck = [];
    for (let suit of SUITS) {
        for (let val of VALUES) {
            room.deck.push({ suit, value: val });
        }
    }
    room.deck.sort(() => Math.random() - 0.5);
    room.trump = room.deck[room.deck.length - 1];
    for (let player of room.players) {
        player.hand = room.deck.splice(0, 6);
    }
    room.turn = 0;
}

function checkWin(roomId) {
    let room = rooms[roomId];
    if (room.deck.length === 0) {
        let p1 = room.players[0];
        let p2 = room.players[1];
        if (p1.hand.length === 0 && p2.hand.length === 0) {
            room.state = "ENDED";
            io.to(roomId).emit('gameOver', { winner: 'draw' });
        } else if (p1.hand.length === 0) {
            room.state = "ENDED";
            io.to(roomId).emit('gameOver', { winner: p1.id });
        } else if (p2.hand.length === 0) {
            room.state = "ENDED";
            io.to(roomId).emit('gameOver', { winner: p2.id });
        }
    }
}

function updateRoom(roomId) {
    let room = rooms[roomId];
    if (!room || room.state !== "PLAYING") return;
    room.players.forEach((player, idx) => {
        let enemy = room.players[(idx + 1) % 2];
        io.to(player.id).emit('gameState', {
            myHand: player.hand,
            enemyCardCount: enemy ? enemy.hand.length : 0,
            table: room.table,
            trump: room.trump,
            isMyTurn: room.turn === idx,
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
