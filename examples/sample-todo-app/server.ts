import express from 'express';
import path from 'node:path';
import todosRouter from './routes/todos';
import usersRouter from './routes/users';

const app = express();

app.use(express.json());
app.use('/api/todos', todosRouter);
app.use('/api/users', usersRouter);
app.use('/assets', express.static(path.join(__dirname, 'public')));

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', service: 'sample-todo-app' });
});

const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
  console.log(`[sample-todo-app] listening on http://localhost:${port}`);
});
