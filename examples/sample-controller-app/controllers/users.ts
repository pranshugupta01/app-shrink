import { Request, Response } from 'express';
import { prisma } from '../db';

export async function listUsers(_req: Request, res: Response) {
  const users = await prisma.user.findMany({ orderBy: { id: 'asc' } });
  res.json(users);
}

export async function getUser(req: Request, res: Response) {
  const user = await prisma.user.findUnique({ where: { id: Number(req.params.id) } });
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.json(user);
}

export async function createUser(req: Request, res: Response) {
  const { email, name } = req.body;
  if (!email || !name) {
    return res.status(400).json({ error: 'email and name are required' });
  }
  const user = await prisma.user.create({ data: { email, name } });
  res.status(201).json(user);
}

export async function deleteUser(req: Request, res: Response) {
  const id = Number(req.params.id);
  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: 'User not found' });
  }
  await prisma.user.delete({ where: { id } });
  res.status(204).send();
}
