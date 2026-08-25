document.addEventListener('verdant:session-ready', (e) => {
  const { session } = e.detail;
  const welcome = document.getElementById('welcome-message');
  if (welcome) {
    welcome.textContent = `Welcome back, ${session.user.display_name}.`;
  }
});
