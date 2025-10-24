/**
 * Magic.link Client-Side Authentication
 *
 * Handles passwordless login using Magic.link SDK
 */

import { Magic } from 'https://esm.sh/magic-sdk@28.0.0';

let magic = null;

// Initialize Magic.link
async function initMagic() {
  try {
    // Get Magic.link config from backend
    const response = await fetch('/api/auth/magic/config');
    const config = await response.json();

    if (!config.enabled) {
      showMessage('Magic.link authentication is not configured on the server', 'error');
      return false;
    }

    // Initialize Magic SDK
    magic = new Magic(config.publishableKey);
    console.log('✅ Magic.link initialized');
    return true;
  } catch (error) {
    console.error('Failed to initialize Magic.link:', error);
    showMessage('Failed to initialize authentication service', 'error');
    return false;
  }
}

// Handle login form submission
async function handleLogin(event) {
  event.preventDefault();

  const emailInput = document.getElementById('email-input');
  const loginButton = document.getElementById('login-button');
  const email = emailInput.value.trim();

  if (!email) {
    showMessage('Please enter your email address', 'error');
    return;
  }

  // Disable form during login
  loginButton.disabled = true;
  loginButton.textContent = 'Sending magic link...';
  hideMessage();

  try {
    // Request magic link from Magic.link
    const didToken = await magic.auth.loginWithMagicLink({ email });

    loginButton.textContent = 'Verifying...';

    // Send DID token to backend for verification
    const response = await fetch('/api/auth/magic/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ didToken }),
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.message || 'Authentication failed');
    }

    // Success! Store DID token for logout
    sessionStorage.setItem('magicDidToken', didToken);

    showMessage(`Welcome ${result.user.email}! Redirecting...`, 'success');

    // Redirect to main app
    setTimeout(() => {
      window.location.href = '/';
    }, 1500);

  } catch (error) {
    console.error('Login error:', error);
    showMessage(error.message || 'Login failed. Please try again.', 'error');

    // Re-enable form
    loginButton.disabled = false;
    loginButton.textContent = 'Send Magic Link';
  }
}

// Show message to user
function showMessage(text, type = 'info') {
  const messageDiv = document.getElementById('message');
  messageDiv.textContent = text;
  messageDiv.className = `login-card__message login-card__message--${type}`;
  messageDiv.style.display = 'block';
}

// Hide message
function hideMessage() {
  const messageDiv = document.getElementById('message');
  messageDiv.style.display = 'none';
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
  const initialized = await initMagic();

  if (!initialized) {
    return;
  }

  // Attach form handler
  const form = document.getElementById('login-form');
  form.addEventListener('submit', handleLogin);

  // Note: No need to check if already logged in - backend middleware handles this
  // and will redirect to / if user has an active session
});
