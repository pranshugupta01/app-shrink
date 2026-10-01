import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Deterministic seed so the verifier can compare byte-for-byte identical
 * datasets across the original and the shrunk service.
 */
async function main() {
  await prisma.todo.deleteMany();
  await prisma.user.deleteMany();

  const ada = await prisma.user.create({
    data: { id: 1, email: 'ada@example.com', name: 'Ada Lovelace' },
  });
  const alan = await prisma.user.create({
    data: { id: 2, email: 'alan@example.com', name: 'Alan Turing' },
  });

  await prisma.todo.create({
    data: { id: 1, title: 'Ship the shrink pipeline', priority: 2, completed: false, userId: ada.id },
  });
  await prisma.todo.create({
    data: { id: 2, title: 'Write differential verifier', priority: 1, completed: true, userId: ada.id },
  });
  await prisma.todo.create({
    data: { id: 3, title: 'Delete the docker-compose file', priority: 3, completed: false, userId: alan.id },
  });

  console.log('[seed] inserted 2 users and 3 todos');
}

main()
  .catch((error) => {
    console.error('[seed] failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
