document.addEventListener('verdant:session-ready', (e) => {
  const { session } = e.detail;
  document.getElementById('profile-name').textContent = session.user.display_name;
  document.getElementById('profile-email').textContent = session.user.email;
});
