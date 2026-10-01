import { Router } from 'express';
import { prisma } from '../db';

const router = Router();

router.get('/', async (req, res) => {
  const completed = req.query.completed;
  const todos = await prisma.todo.findMany({
    where: completed === undefined ? {} : { completed: completed === 'true' },
    orderBy: { createdAt: 'asc' },
  });
  res.json(todos);
});

router.get('/:id', async (req, res) => {
  const todo = await prisma.todo.findUnique({
    where: { id: Number(req.params.id) },
  });
  if (!todo) {
    return res.status(404).json({ error: 'Todo not found' });
  }
  res.json(todo);
});

router.post('/', async (req, res) => {
  const { title, userId, priority } = req.body;
  if (!title) {
    return res.status(400).json({ error: 'title is required' });
  }
  const todo = await prisma.todo.create({
    data: {
      title,
      userId: Number(userId),
      priority: priority === undefined ? 0 : Number(priority),
      completed: false,
    },
  });
  res.status(201).json(todo);
});

router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.todo.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: 'Todo not found' });
  }
  const todo = await prisma.todo.update({
    where: { id },
    data: req.body,
  });
  res.json(todo);
});

router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.todo.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: 'Todo not found' });
  }
  await prisma.todo.delete({ where: { id } });
  res.status(204).send();
});

export default router;
