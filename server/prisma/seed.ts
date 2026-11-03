import 'dotenv/config'
import bcrypt from 'bcryptjs'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const demoUser = await prisma.user.upsert({
    where: { email: 'ariana@echoroom.app' },
    update: {},
    create: {
      fullName: 'Ariana Cole',
      username: 'ariana',
      email: 'ariana@echoroom.app',
      passwordHash: await bcrypt.hash('password123', 12),
    },
  })

  await prisma.user.upsert({
    where: { email: 'admin@echoroom.app' },
    update: {},
    create: {
      fullName: 'EchoRoom Admin',
      username: 'admin',
      email: 'admin@echoroom.app',
      passwordHash: await bcrypt.hash('AdminPass123!', 12),
      role: 'ADMIN',
    },
  })

  const categories = await Promise.all([
    { name: 'Technology', description: 'Products, engineering, and emerging technology.' },
    { name: 'Business', description: 'Founders, operators, and new ideas.' },
    { name: 'Music', description: 'Listening rooms and artist conversations.' },
    { name: 'Lifestyle', description: 'Everyday habits and creative routines.' },
    { name: 'Education', description: 'Learning together and sharing expertise.' },
  ].map((category) => prisma.category.upsert({
    where: { name: category.name },
    update: { description: category.description },
    create: category,
  })))
  const categoryId = new Map(categories.map((category) => [category.name, category.id]))

  const rooms = [
    {
      id: 'r1',
      title: 'AI Builders Roundtable',
      description: 'Discuss product, systems, and shipping patterns with founders and engineers.',
      category: 'Technology',
      status: 'LIVE',
    },
    {
      id: 'r2',
      title: 'Morning Growth Lab',
      description: 'Peer conversations around community growth, experiments, and retention loops.',
      category: 'Business',
      status: 'LIVE',
    },
    {
      id: 'r3',
      title: 'Late Night Jazz Session',
      description: 'A mellow room for listening, sharing favorite tracks, and discovering new artists.',
      category: 'Music',
      status: 'SCHEDULED',
    },
  ]

  for (const room of rooms) {
    await prisma.room.upsert({
      where: { id: room.id },
      update: {},
      create: {
        id: room.id,
        title: room.title,
        description: room.description,
        categoryId: categoryId.get(room.category),
        hostId: demoUser.id,
        status: room.status,
      },
    })
  }

  const discussions = [
    {
      id: 'd1',
      title: 'Best ways to run a weekly creator routine?',
      content: 'What rituals help you publish consistently without burning out?',
      category: 'Lifestyle',
    },
    {
      id: 'd2',
      title: 'What habits make learning sustainable?',
      content: 'Share the routines that help you keep learning over the long term.',
      category: 'Education',
    },
  ]

  for (const discussion of discussions) {
    await prisma.discussion.upsert({
      where: { id: discussion.id },
      update: {},
      create: {
        id: discussion.id,
        title: discussion.title,
        content: discussion.content,
        userId: demoUser.id,
        categoryId: categoryId.get(discussion.category),
      },
    })
  }

  const seedNotifications = [
    { id: 'n1', type: 'New follower', title: 'New follower', message: 'Alex followed you.', isRead: false },
    { id: 'n2', type: 'Speaker request accepted', title: 'Request approved', message: 'Your request to speak was approved.', isRead: true },
    { id: 'n3', type: 'Room starting soon', title: 'Room reminder', message: 'Creator Circle starts in 10 minutes.', isRead: false },
  ]

  for (const notification of seedNotifications) {
    await prisma.notification.upsert({
      where: { id: notification.id },
      update: {},
      create: { ...notification, userId: demoUser.id },
    })
  }

  console.log('EchoRoom demo data is ready.')
}

main()
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })