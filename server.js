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

io.on('connection', (socket) => {
    socket.on('joinRoom', (roomId) => {
        socket.join(roomId);
        if (!rooms[roomId]) {
            rooms[roomId] = { players: [], deck: [], trump: null, table: [], attackerIdx: 0, state: "WAITING" };
        }
        let room = rooms[roomId];
        if (room.players.length < 2 && !room.players.some(p => p.id === socket.id)) {
            room.players.push({ id: socket.id, hand: [], name: `Игрок ${room.players.length + 1}` });
        }
        if (room.players.length === 2 && room.state === "WAITING") {
            initGame(room);
        } else if (room.state === "WAITING") {
            socket.emit('status', "Ожидаем второго игрока...");
        }
        updateRoom(roomId);
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

        // 1. ХОД НАПАДАЮЩЕГО (Атака / Подкидывание)
        if (playerIdx === room.attackerIdx) {
            if (room.table.length === 0) {
                // Первый ход в коне — можно любой картой
                player.hand.splice(cardIdx, 1);
                room.table.push({ attack: card, defense: null });
                updateRoom(roomId);
            } else {
                // Подкидывание: проверяем совпадение номинала с картами на столе
                let allowedNames = [];
                room.table.forEach(pair => {
                    allowedNames.push(pair.attack.value.name);
                    if (pair.defense) allowedNames.push(pair.defense.value.name);
                });
                
                if (allowedNames.includes(card.value.name)) {
                    player.hand.splice(cardIdx, 1);
                    room.table.push({ attack: card, defense: null });
                    updateRoom(roomId);
                }
            }
        } 
        // 2. ХОД ЗАЩИЩАЮЩЕГОСЯ (Отбой)
        else if (playerIdx === defenderIdx) {
            // Ищем первую карту, которую нужно побить
            let pairToBeat = room.table.find(pair => pair.defense === null);
            if (!pairToBeat) return; // Всё уже побито, ждем подкидывания

            if (canBeat(pairToBeat.attack, card, room.trump.suit.id)) {
                player.hand.splice(cardIdx, 1);
                pairToBeat.defense = card;
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

        // Нападающий нажимает "БИТО"
        if (playerIdx === room.attackerIdx && room.table.length > 0) {
            let allBeaten = room.table.every(pair => pair.defense !== null);
            if (allBeaten) {
                room.table = [];
                drawCards(room);
                room.attackerIdx = defenderIdx; // Ход переходит к защитнику
                checkWin(roomId);
                updateRoom(roomId);
            }
        } 
        // Защитник нажимает "ВЗЯТЬ КАРТЫ"
        else if (playerIdx === defenderIdx && room.table.length > 0) {
            let defender = room.players[defenderIdx];
            room.table.forEach(pair => {
                defender.hand.push(pair.attack);
                if (pair.defense) defender.hand.push(pair.defense);
            });
            room.table = [];
            drawCards(room); // Нападающий добирает, защитник — нет, т.к. взял карты
            // Ход переходит к следующему игроку (в дуэли это значит, что нападающий снова ходит)
            checkWin(roomId);
            updateRoom(roomId);
        }
    });

    socket.on('disconnect', () => {
        let roomId = getPlayerRoom(socket.id);
        if (roomId && rooms[roomId]) {
            io.to(roomId).emit('status', "Соперник отключился.");
            delete rooms[roomId];
        }
    });
});

// Функция проверки: бьет ли карта защиты карту атаки
function canBeat(attack, defense, trumpSuitId) {
    // 1. Если масти совпадают, карта защиты должна быть сильнее
    if (attack.suit.id === defense.suit.id) {
        return defense.value.strength > attack.value.strength;
    }
    // 2. Если атаковали НЕ козырем, а защищаются КОЗЫРЕМ — бить можно всегда
    if (attack.suit.id !== trumpSuitId && defense.suit.id === trumpSuitId) {
        return true;
    }
    // Во всех остальных случаях ход невозможен
    return false;
}
function initGame(room) {
    room.state = "PLAYING";
    room.deck = [];
    // Создаем колоду 36 карт
    for (let suit of SUITS) {
        for (let val of VALUES) {
            room.deck.push({ suit, value: val });
        }
    }
    // Тасуем колоду
    room.deck.sort(() => Math.random() - 0.5);
    
    // Раздаем по 6 карт
    for (let player of room.players) {
        player.hand = room.deck.splice(0, 6);
    }
    
    // Козырь — нижняя карта
    room.trump = room.deck[room.deck.length - 1];

    // Определяем, у кого младший козырь для первого хода
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
}

// Добор карт до 6 штук
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
            room.state = "ENDED"; io.to(roomId).emit('gameOver', { winner: 'draw' });
        } else if (p1.hand.length === 0) {
            room.state = "ENDED"; io.to(roomId).emit('gameOver', { winner: p1.id });
        } else if (p2.hand.length === 0) {
            room.state = "ENDED"; io.to(roomId).emit('gameOver', { winner: p2.id });
        }
    }
}

function updateRoom(roomId) {
    let room = rooms[roomId];
    if (!room || room.state !== "PLAYING") return;
    
    room.players.forEach((player, idx) => {
        let enemy = room.players[(idx + 1) % 2];
        let isAttacker = (idx === room.attackerIdx);
        
        io.to(player.id).emit('gameState', {
            myHand: player.hand,
            enemyCardCount: enemy ? enemy.hand.length : 0,
            table: room.table,
            trump: room.trump,
            isAttacker: isAttacker,
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
