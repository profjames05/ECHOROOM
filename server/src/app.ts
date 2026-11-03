import 'dotenv/config';
import bcrypt from 'bcryptjs';
import cors from 'cors';
import express, { type Request, type RequestHandler, type Response } from 'express';
import jwt from 'jsonwebtoken';
import { Prisma, PrismaClient } from '@prisma/client';
import { CLIENT_URL, JWT_SECRET } from './config.js';

const app = express();
const prisma = new PrismaClient();

app.use(cors({ origin: CLIENT_URL, credentials: true }));
app.use(express.json());

const asyncRoute = (handler: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    void handler(req, res).catch(next);
  };

const authenticate: RequestHandler = (req, res, next) => {
  const authorization = req.header('authorization');
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;

  if (!token) {
    res.status(401).json({ message: 'Sign in to continue.' });
    return;
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (typeof payload === 'string' || !payload.sub) {
      res.status(401).json({ message: 'Invalid session.' });
      return;
    }
    res.locals.userId = payload.sub;
    next();
  } catch {
    res.status(401).json({ message: 'Your session has expired. Sign in again.' });
  }
};

const userIdFrom = (res: Response) => res.locals.userId as string;
const routeId = (req: Request) => {
  const value = req.params.id;
  return Array.isArray(value) ? value[0] ?? '' : value;
};

const makeToken = (user: { id: string; role: string }) =>
  jwt.sign({ role: user.role }, JWT_SECRET, { subject: user.id, expiresIn: '7d' });

const publicUser = (user: { id: string; fullName: string; username: string; email: string; role: string }) => ({
  id: user.id,
  fullName: user.fullName,
  username: user.username,
  email: user.email,
  role: user.role,
});

const roomInclude = {
  host: { select: { id: true, fullName: true, username: true } },
  category: { select: { name: true } },
  participants: {
    where: { leftAt: null },
    select: { role: true, user: { select: { id: true, fullName: true } } },
  },
} satisfies Prisma.RoomInclude;

const serializeRoom = (room: Prisma.RoomGetPayload<{ include: typeof roomInclude }>) => ({
  id: room.id,
  title: room.title,
  description: room.description ?? '',
  host: room.host.fullName,
  hostId: room.host.id,
  category: room.category?.name ?? 'General',
  listeners: room.participants.filter((participant) => participant.role === 'LISTENER').length,
  speakers: [room.host.fullName, ...room.participants
    .filter((participant) => participant.role === 'SPEAKER' && participant.user.id !== room.host.id)
    .map((participant) => participant.user.fullName)],
  live: room.status === 'LIVE',
  status: room.status,
});

app.get('/api/health', asyncRoute(async (_req, res) => {
  await prisma.$queryRaw`SELECT 1`;
  res.json({ status: 'ok', service: 'echoroom-api', database: 'connected', timestamp: new Date().toISOString() });
}));

app.post('/api/auth/register', asyncRoute(async (req, res) => {
  const { fullName, email, password } = req.body as { fullName?: string; email?: string; password?: string };
  const normalizedEmail = email?.trim().toLowerCase();

  if (!fullName?.trim() || !normalizedEmail || !password) {
    res.status(400).json({ message: 'Name, email, and password are required.' });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ message: 'Password must be at least 8 characters.' });
    return;
  }
  if (await prisma.user.findUnique({ where: { email: normalizedEmail } })) {
    res.status(409).json({ message: 'An account with this email already exists.' });
    return;
  }

  const baseUsername = fullName.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20) || 'member';
  let username = baseUsername;
  while (await prisma.user.findUnique({ where: { username } })) {
    username = `${baseUsername}${Math.floor(1000 + Math.random() * 9000)}`;
  }

  const user = await prisma.user.create({
    data: {
      fullName: fullName.trim(),
      username,
      email: normalizedEmail,
      passwordHash: await bcrypt.hash(password, 12),
    },
  });

  res.status(201).json({ message: 'Account created. You are signed in.', user: publicUser(user), token: makeToken(user) });
}));

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string };
  const user = email ? await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } }) : null;

  if (!user?.passwordHash || !password || !(await bcrypt.compare(password, user.passwordHash))) {
    res.status(401).json({ message: 'Email or password is incorrect.' });
    return;
  }
  if (user.status !== 'ACTIVE') {
    res.status(403).json({ message: 'This account is currently unavailable.' });
    return;
  }

  res.json({ message: 'Signed in successfully.', user: publicUser(user), token: makeToken(user) });
}));

app.get('/api/auth/me', authenticate, asyncRoute(async (_req, res) => {
  const user = await prisma.user.findUnique({ where: { id: userIdFrom(res) } });
  if (!user) {
    res.status(404).json({ message: 'Account not found.' });
    return;
  }
  res.json(publicUser(user));
}));

app.get('/api/rooms', asyncRoute(async (_req, res) => {
  const rooms = await prisma.room.findMany({
    where: { roomType: 'PUBLIC', status: { in: ['LIVE', 'SCHEDULED'] } },
    include: roomInclude,
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
  });
  const serializedRooms = rooms.map(serializeRoom);
  res.json({ rooms: serializedRooms, total: serializedRooms.length });
}));

app.get('/api/rooms/:id', asyncRoute(async (req, res) => {
  const room = await prisma.room.findUnique({ where: { id: routeId(req) }, include: roomInclude });
  if (!room) {
    res.status(404).json({ message: 'Room not found.' });
    return;
  }
  res.json({ room: serializeRoom(room) });
}));

app.post('/api/rooms', authenticate, asyncRoute(async (req, res) => {
  const { title, description, category, roomType } = req.body as {
    title?: string; description?: string; category?: string; roomType?: string;
  };
  if (!title?.trim()) {
    res.status(400).json({ message: 'Room title is required.' });
    return;
  }

  const categoryName = category?.trim() || 'General';
  const categoryRecord = await prisma.category.upsert({
    where: { name: categoryName },
    update: {},
    create: { name: categoryName },
  });
  const room = await prisma.room.create({
    data: {
      title: title.trim(),
      description: description?.trim(),
      roomType: roomType === 'PRIVATE' ? 'PRIVATE' : 'PUBLIC',
      status: 'LIVE',
      hostId: userIdFrom(res),
      categoryId: categoryRecord.id,
      participants: { create: { userId: userIdFrom(res), role: 'SPEAKER' } },
    },
    include: roomInclude,
  });
  res.status(201).json({ room: serializeRoom(room) });
}));

app.post('/api/rooms/:id/join', authenticate, asyncRoute(async (req, res) => {
  const room = await prisma.room.findUnique({ where: { id: routeId(req) } });
  if (!room || room.status === 'ENDED') {
    res.status(404).json({ message: 'Live room not found.' });
    return;
  }

  const userId = userIdFrom(res);
  const existing = await prisma.roomParticipant.findUnique({ where: { roomId_userId: { roomId: room.id, userId } } });
  if (!existing || existing.leftAt) {
    const listenerCount = await prisma.roomParticipant.count({ where: { roomId: room.id, leftAt: null, role: 'LISTENER' } });
    if (room.maximumParticipants && listenerCount >= room.maximumParticipants) {
      res.status(409).json({ message: 'This room has reached its listener limit.' });
      return;
    }
  }

  await prisma.roomParticipant.upsert({
    where: { roomId_userId: { roomId: room.id, userId } },
    update: { leftAt: null, role: 'LISTENER' },
    create: { roomId: room.id, userId, role: 'LISTENER' },
  });
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { username: true } });
  res.json({ message: `${user.username} joined ${room.title}.`, joined: true, roomId: room.id });
}));

app.post('/api/rooms/:id/leave', authenticate, asyncRoute(async (req, res) => {
  const result = await prisma.roomParticipant.updateMany({
    where: { roomId: routeId(req), userId: userIdFrom(res), leftAt: null },
    data: { leftAt: new Date() },
  });
  if (result.count === 0) {
    res.status(404).json({ message: 'You are not an active participant in this room.' });
    return;
  }
  res.json({ message: 'You left the room.' });
}));

app.post('/api/rooms/:id/speaker-requests', authenticate, asyncRoute(async (req, res) => {
  const roomId = routeId(req);
  const userId = userIdFrom(res);
  const participant = await prisma.roomParticipant.findFirst({ where: { roomId, userId, leftAt: null } });
  if (!participant) {
    res.status(403).json({ message: 'Join the room before requesting to speak.' });
    return;
  }

  const pendingRequest = await prisma.speakerRequest.findFirst({ where: { roomId, userId, status: 'PENDING' } });
  const request = pendingRequest ?? await prisma.speakerRequest.create({ data: { roomId, userId } });
  res.status(pendingRequest ? 200 : 201).json({ request });
}));

app.get('/api/rooms/:id/messages', asyncRoute(async (req, res) => {
  const messages = await prisma.chatMessage.findMany({
    where: { roomId: routeId(req) },
    include: { user: { select: { id: true, username: true, fullName: true } } },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });
  res.json({ messages });
}));

app.get('/api/discussions', asyncRoute(async (_req, res) => {
  const discussions = await prisma.discussion.findMany({
    include: {
      user: { select: { id: true, fullName: true, username: true } },
      category: { select: { name: true } },
      _count: { select: { comments: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  const reactionCounts = await prisma.reaction.groupBy({
    by: ['entityId'],
    where: { entityType: 'DISCUSSION', entityId: { in: discussions.map((discussion) => discussion.id) } },
    _count: { _all: true },
  });
  const reactionMap = new Map(reactionCounts.map((entry) => [entry.entityId, entry._count._all]));
  const result = discussions.map((discussion) => ({
    id: discussion.id,
    title: discussion.title,
    content: discussion.content,
    author: discussion.user.fullName,
    category: discussion.category?.name ?? 'General',
    comments: discussion._count.comments,
    reactions: reactionMap.get(discussion.id) ?? 0,
  }));
  res.json({ discussions: result, total: result.length });
}));

app.get('/api/discussions/:id/comments', asyncRoute(async (req, res) => {
  const discussionId = routeId(req);
  const discussion = await prisma.discussion.findUnique({ where: { id: discussionId }, select: { id: true } });
  if (!discussion) {
    res.status(404).json({ message: 'Discussion not found.' });
    return;
  }
  const comments = await prisma.comment.findMany({
    where: { discussionId },
    include: { user: { select: { id: true, username: true, fullName: true } } },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ comments });
}));

app.post('/api/discussions/:id/comments', authenticate, asyncRoute(async (req, res) => {
  const discussionId = routeId(req);
  const { content } = req.body as { content?: string };
  if (!content?.trim()) {
    res.status(400).json({ message: 'Comment text is required.' });
    return;
  }
  const discussion = await prisma.discussion.findUnique({ where: { id: discussionId }, select: { id: true } });
  if (!discussion) {
    res.status(404).json({ message: 'Discussion not found.' });
    return;
  }
  const comment = await prisma.comment.create({
    data: { discussionId, content: content.trim(), userId: userIdFrom(res) },
    include: { user: { select: { id: true, username: true, fullName: true } } },
  });
  res.status(201).json({ comment });
}));

app.post('/api/discussions/:id/reactions', authenticate, asyncRoute(async (req, res) => {
  const discussionId = routeId(req);
  const userId = userIdFrom(res);
  const discussion = await prisma.discussion.findUnique({ where: { id: discussionId }, select: { id: true } });
  if (!discussion) {
    res.status(404).json({ message: 'Discussion not found.' });
    return;
  }
  const existing = await prisma.reaction.findFirst({
    where: { entityType: 'DISCUSSION', entityId: discussionId, userId, reactionType: 'LIKE' },
  });
  if (existing) {
    await prisma.reaction.delete({ where: { id: existing.id } });
  } else {
    await prisma.reaction.create({ data: { entityType: 'DISCUSSION', entityId: discussionId, userId, reactionType: 'LIKE' } });
  }
  const reactions = await prisma.reaction.count({ where: { entityType: 'DISCUSSION', entityId: discussionId } });
  res.json({ reacted: !existing, reactions });
}));

app.post('/api/discussions', authenticate, asyncRoute(async (req, res) => {
  const { title, content, category } = req.body as { title?: string; content?: string; category?: string };
  if (!title?.trim() || !content?.trim()) {
    res.status(400).json({ message: 'A title and discussion text are required.' });
    return;
  }

  let categoryId: string | undefined;
  if (category?.trim()) {
    const categoryRecord = await prisma.category.upsert({ where: { name: category.trim() }, update: {}, create: { name: category.trim() } });
    categoryId = categoryRecord.id;
  }
  const discussion = await prisma.discussion.create({
    data: { title: title.trim(), content: content.trim(), userId: userIdFrom(res), categoryId },
    include: { user: { select: { fullName: true } }, category: { select: { name: true } } },
  });
  res.status(201).json({
    discussion: {
      id: discussion.id,
      title: discussion.title,
      content: discussion.content,
      author: discussion.user.fullName,
      category: discussion.category?.name ?? 'General',
      comments: 0,
      reactions: 0,
    },
  });
}));

app.get('/api/notifications', authenticate, asyncRoute(async (_req, res) => {
  const notifications = await prisma.notification.findMany({
    where: { userId: userIdFrom(res) },
    orderBy: { createdAt: 'desc' },
  });
  const result = notifications.map((notification) => ({
    id: notification.id,
    type: notification.type,
    title: notification.title,
    message: notification.message,
    read: notification.isRead,
  }));
  res.json({ notifications: result, total: result.length });
}));

app.post('/api/notifications/:id/read', authenticate, asyncRoute(async (req, res) => {
  const result = await prisma.notification.updateMany({
    where: { id: routeId(req), userId: userIdFrom(res) },
    data: { isRead: true },
  });
  if (result.count === 0) {
    res.status(404).json({ message: 'Notification not found.' });
    return;
  }
  res.json({ message: 'Notification marked as read.' });
}));

app.post('/api/feedback', authenticate, asyncRoute(async (req, res) => {
  const { category, subject, description, rating } = req.body as {
    category?: string; subject?: string; description?: string; rating?: number;
  };
  if (!category?.trim() || !subject?.trim() || !description?.trim()) {
    res.status(400).json({ message: 'Category, subject, and description are required.' });
    return;
  }
  const feedback = await prisma.feedback.create({
    data: {
      category: category.trim(),
      subject: subject.trim(),
      description: description.trim(),
      rating: Number.isInteger(rating) && rating! >= 1 && rating! <= 5 ? rating : undefined,
      userId: userIdFrom(res),
    },
  });
  res.status(201).json({ feedback });
}));

app.get('/api/admin/dashboard', authenticate, asyncRoute(async (_req, res) => {
  const user = await prisma.user.findUnique({ where: { id: userIdFrom(res) }, select: { role: true } });
  if (user?.role !== 'ADMIN') {
    res.status(403).json({ message: 'Administrator access required.' });
    return;
  }
  const [users, activeUsers, rooms, activeRooms, discussions, highlights, reports, feedback] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { status: 'ACTIVE' } }),
    prisma.room.count(),
    prisma.room.count({ where: { status: 'LIVE' } }),
    prisma.discussion.count(),
    prisma.highlight.count(),
    prisma.report.count({ where: { status: 'OPEN' } }),
    prisma.feedback.count(),
  ]);
  res.json({ users, activeUsers, rooms, activeRooms, discussions, highlights, reports, feedback });
}));

app.get('/api/admin/overview', authenticate, asyncRoute(async (_req, res) => {
  const user = await prisma.user.findUnique({ where: { id: userIdFrom(res) }, select: { role: true } });
  if (user?.role !== 'ADMIN') {
    res.status(403).json({ message: 'Administrator access required.' });
    return;
  }
  const [rooms, members, reports, feedback] = await Promise.all([
    prisma.room.findMany({ include: roomInclude, orderBy: { updatedAt: 'desc' }, take: 8 }),
    prisma.user.findMany({
      select: { id: true, fullName: true, username: true, email: true, role: true, status: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 8,
    }),
    prisma.report.findMany({
      select: { id: true, reason: true, status: true, entityType: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 8,
    }),
    prisma.feedback.findMany({
      select: { id: true, subject: true, category: true, status: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 8,
    }),
  ]);
  res.json({ rooms: rooms.map(serializeRoom), members, reports, feedback });
}));

app.patch('/api/admin/rooms/:id/end', authenticate, asyncRoute(async (req, res) => {
  const admin = await prisma.user.findUnique({ where: { id: userIdFrom(res) }, select: { role: true } });
  if (admin?.role !== 'ADMIN') {
    res.status(403).json({ message: 'Administrator access required.' });
    return;
  }
  const result = await prisma.room.updateMany({ where: { id: routeId(req), status: { not: 'ENDED' } }, data: { status: 'ENDED' } });
  if (!result.count) {
    res.status(404).json({ message: 'Active room not found.' });
    return;
  }
  res.json({ message: 'Room ended by an administrator.' });
}));

app.patch('/api/admin/reports/:id/resolve', authenticate, asyncRoute(async (req, res) => {
  const admin = await prisma.user.findUnique({ where: { id: userIdFrom(res) }, select: { role: true } });
  if (admin?.role !== 'ADMIN') {
    res.status(403).json({ message: 'Administrator access required.' });
    return;
  }
  const result = await prisma.report.updateMany({ where: { id: routeId(req), status: 'OPEN' }, data: { status: 'RESOLVED' } });
  if (!result.count) {
    res.status(404).json({ message: 'Open report not found.' });
    return;
  }
  res.json({ message: 'Report marked as resolved.' });
}));

app.use((err: Error, _req: Request, res: Response, _next: (error?: unknown) => void) => {
  console.error(err);
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    res.status(409).json({ message: 'That account name or email is already in use.' });
    return;
  }
  res.status(500).json({ message: 'Something went wrong.' });
});

export default app;
