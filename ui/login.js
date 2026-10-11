document.querySelector('#login').addEventListener('submit', async event => {
  event.preventDefault();
  const message = document.querySelector('#message');
  try {
    const response = await fetch('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: document.querySelector('#token').value.trim() }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '登录失败');
    location.href = '/connection.html';
  } catch (error) { message.textContent = error.message; }
});
