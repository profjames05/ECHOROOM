import http from 'node:http';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { Server } from 'socket.io';
import app from './app.js';
import { CLIENT_URL, JWT_SECRET } from './config.js';

const PORT = Number(process.env.PORT ?? 4000);
const prisma = new PrismaClient();
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: CLIENT_URL,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

io.use((socket, next) => {
  const token = socket.handshake.auth.token as string | undefined;
  if (!token) {
    next();
    return;
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (typeof payload === 'string' || !payload.sub) {
      next(new Error('Invalid session.'));
      return;
    }
    socket.data.userId = payload.sub;
    next();
  } catch {
    next(new Error('Invalid session.'));
  }
});

io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id, socket.data.userId ? 'authenticated' : 'guest');

  socket.on('room:join', async (roomId: string) => {
    if (typeof roomId !== 'string' || roomId.length > 100) return;
    const room = await prisma.room.findUnique({ where: { id: roomId }, select: { id: true, roomType: true } });
    if (!room || (room.roomType === 'PRIVATE' && !socket.data.userId)) return;

    const peers = [...(io.sockets.adapter.rooms.get(roomId) ?? [])].filter((peerId) => peerId !== socket.id);
    socket.join(roomId);
    const participant = socket.data.userId
      ? await prisma.roomParticipant.upsert({
          where: { roomId_userId: { roomId, userId: socket.data.userId as string } },
          update: { leftAt: null },
          create: { roomId, userId: socket.data.userId as string },
          include: { user: { select: { id: true, username: true, fullName: true } } },
        })
      : null;
    socket.to(roomId).emit('room:participant-joined', {
      roomId,
      user: participant?.user ?? { id: socket.id, username: 'guest', fullName: 'Guest listener' },
    });
    socket.emit('voice:peers', peers);
    socket.to(roomId).emit('voice:peer-joined', { peerId: socket.id });
  });

  socket.on('room:leave', async (roomId: string) => {
    if (typeof roomId !== 'string') return;
    socket.leave(roomId);
    if (socket.data.userId) {
      await prisma.roomParticipant.updateMany({
        where: { roomId, userId: socket.data.userId as string, leftAt: null },
        data: { leftAt: new Date() },
      });
    }
    socket.to(roomId).emit('room:participant-left', { roomId, userId: socket.data.userId ?? socket.id });
  });

  socket.on('chat:message', async (payload: { roomId?: string; content?: string }) => {
    const roomId = payload?.roomId;
    const content = payload?.content?.trim();
    const userId = socket.data.userId as string | undefined;
    if (!userId || !roomId || !content || content.length > 1000 || !socket.rooms.has(roomId)) return;

    const message = await prisma.chatMessage.create({
      data: { roomId, userId, content },
      include: { user: { select: { id: true, username: true, fullName: true } } },
    });
    io.to(roomId).emit('chat:message', message);
  });

  socket.on('speaker:request', async (payload: { roomId?: string }) => {
    const roomId = payload?.roomId;
    const userId = socket.data.userId as string | undefined;
    if (!userId || !roomId || !socket.rooms.has(roomId)) return;

    const existing = await prisma.speakerRequest.findFirst({ where: { roomId, userId, status: 'PENDING' } });
    const request = existing ?? await prisma.speakerRequest.create({ data: { roomId, userId } });
    io.to(roomId).emit('speaker:request-received', { roomId, request });
  });

  socket.on('voice:offer', (payload: { roomId?: string; targetId?: string; description?: RTCSessionDescriptionInit }) => {
    const { roomId, targetId, description } = payload ?? {};
    const target = targetId ? io.sockets.sockets.get(targetId) : undefined;
    if (!roomId || !target || !socket.rooms.has(roomId) || !target.rooms.has(roomId) || !description) return;
    target.emit('voice:offer', { from: socket.id, description });
  });

  socket.on('voice:answer', (payload: { roomId?: string; targetId?: string; description?: RTCSessionDescriptionInit }) => {
    const { roomId, targetId, description } = payload ?? {};
    const target = targetId ? io.sockets.sockets.get(targetId) : undefined;
    if (!roomId || !target || !socket.rooms.has(roomId) || !target.rooms.has(roomId) || !description) return;
    target.emit('voice:answer', { from: socket.id, description });
  });

  socket.on('voice:ice-candidate', (payload: { roomId?: string; targetId?: string; candidate?: RTCIceCandidateInit }) => {
    const { roomId, targetId, candidate } = payload ?? {};
    const target = targetId ? io.sockets.sockets.get(targetId) : undefined;
    if (!roomId || !target || !socket.rooms.has(roomId) || !target.rooms.has(roomId) || !candidate) return;
    target.emit('voice:ice-candidate', { from: socket.id, candidate });
  });

  socket.on('disconnecting', async () => {
    for (const roomId of socket.rooms) {
      if (roomId === socket.id) continue;
      if (socket.data.userId) {
        await prisma.roomParticipant.updateMany({
          where: { roomId, userId: socket.data.userId as string, leftAt: null },
          data: { leftAt: new Date() },
        });
      }
      socket.to(roomId).emit('room:participant-left', { roomId, userId: socket.data.userId ?? socket.id });
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`EchoRoom server running on http://localhost:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    httpServer.close(() => {
      void prisma.$disconnect();
    });
  });
}
