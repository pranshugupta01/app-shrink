import { Request, Response } from 'express';
import { prisma } from '../db';

export async function listTodos(req: Request, res: Response) {
  const completed = req.query.completed;
  const todos = await prisma.todo.findMany({
    where: completed === undefined ? {} : { completed: completed === 'true' },
    orderBy: { createdAt: 'asc' },
  });
  res.json(todos);
}

export async function getTodo(req: Request, res: Response) {
  const todo = await prisma.todo.findUnique({
    where: { id: Number(req.params.id) },
  });
  if (!todo) {
    return res.status(404).json({ error: 'Todo not found' });
  }
  res.json(todo);
}

export async function createTodo(req: Request, res: Response) {
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
}

export async function updateTodo(req: Request, res: Response) {
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
}

export async function deleteTodo(req: Request, res: Response) {
  const id = Number(req.params.id);
  const existing = await prisma.todo.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: 'Todo not found' });
  }
  await prisma.todo.delete({ where: { id } });
  res.status(204).send();
}

export const todoController = {
  countTodos: async (_req: Request, res: Response) => {
    const count = await prisma.todo.count();
    res.json({ count });
  },
};
