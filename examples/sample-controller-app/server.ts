import express from 'express';
import { PrismaClient } from '@prisma/client';
import todosRouter from './routes/todos';
import usersRouter from './routes/users';
import { todoController } from './controllers/todos';

export const prisma = new PrismaClient();

const app = express();
app.use(express.json());

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.use('/api/todos', todosRouter);
app.use('/api/users', usersRouter);
app.get('/api/todos/count', todoController.countTodos);

const PORT = Number(process.env.PORT ?? 4000);
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`sample-controller-app listening on ${PORT}`);
  });
}
export default app;
