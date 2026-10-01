import { Router } from 'express';
import { prisma } from '../db';

const router = Router();

router.get('/', async (req, res) => {
  const users = await prisma.user.findMany({
    orderBy: { id: 'asc' },
  });
  res.json(users);
});

router.get('/:id', async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: Number(req.params.id) },
  });
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.json(user);
});

router.post('/', async (req, res) => {
  const { email, name } = req.body;
  if (!email || !name) {
    return res.status(400).json({ error: 'email and name are required' });
  }
  const user = await prisma.user.create({
    data: { email, name },
  });
  res.status(201).json(user);
});

router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: 'User not found' });
  }
  await prisma.user.delete({ where: { id } });
  res.status(204).send();
});

export default router;
