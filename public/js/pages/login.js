import { insforge } from '../insforge-client.js';

const form = document.getElementById('auth-form');
const modeToggle = document.getElementById('mode-toggle');
const displayNameField = document.getElementById('display-name-field');
const submitBtn = document.getElementById('submit-btn');
const titleEl = document.getElementById('form-title');
const errorEl = document.getElementById('form-error');
const passwordInput = document.getElementById('password');
const passwordToggle = document.getElementById('password-toggle');

passwordToggle.addEventListener('click', () => {
  const isHidden = passwordInput.type === 'password';
  passwordInput.type = isHidden ? 'text' : 'password';
  passwordToggle.textContent = isHidden ? 'Hide' : 'Show';
  passwordToggle.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
  passwordToggle.setAttribute('aria-pressed', String(isHidden));
});

let mode = 'signin'; // 'signin' | 'signup'

function setMode(next) {
  mode = next;
  const isSignup = mode === 'signup';
  displayNameField.hidden = !isSignup;
  titleEl.textContent = isSignup ? 'Create your account' : 'Sign in';
  submitBtn.textContent = isSignup ? 'Sign up' : 'Sign in';
  modeToggle.textContent = isSignup
    ? 'Already have an account? Sign in'
    : "Don't have an account? Sign up";
  errorEl.textContent = '';
}

modeToggle.addEventListener('click', () => setMode(mode === 'signup' ? 'signin' : 'signup'));

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.textContent = '';
  submitBtn.disabled = true;

  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const displayName = document.getElementById('display-name').value.trim();

  try {
    if (mode === 'signup') {
      await insforge.auth.signUp({ email, password, displayName });
    } else {
      await insforge.auth.signIn({ email, password });
    }
    window.location.href = nextPath();
  } catch (err) {
    errorEl.textContent = err.message || 'Something went wrong. Please try again.';
  } finally {
    submitBtn.disabled = false;
  }
});

// Only same-origin paths (from sidebar.js's ?next=), never an absolute URL.
function nextPath() {
  const next = new URLSearchParams(window.location.search).get('next');
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/index.html';
}

(async function redirectIfAuthenticated() {
  const session = await insforge.auth.getSession();
  if (session) window.location.href = nextPath();
})();
