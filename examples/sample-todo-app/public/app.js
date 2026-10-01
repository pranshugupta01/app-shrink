async function load() {
  const status = document.getElementById('status');
  const list = document.getElementById('list');
  try {
    const res = await fetch('/api/todos');
    const todos = await res.json();
    status.textContent = `${todos.length} todo(s)`;
    list.innerHTML = todos
      .map((t) => `<li class="${t.completed ? 'done' : ''}">${t.title}</li>`)
      .join('');
  } catch (error) {
    status.textContent = `Failed to load: ${error.message}`;
  }
}

load();
