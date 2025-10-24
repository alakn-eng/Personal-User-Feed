/**
 * Authentication Check & User Profile
 *
 * Runs on index.html to:
 * 1. Verify user is authenticated (redirect to login if not)
 * 2. Display user email in profile dropdown
 * 3. Handle logout
 */

import { Magic } from 'https://esm.sh/magic-sdk@28.0.0';

let magic = null;
let currentUser = null;

// Initialize Magic.link
async function initMagic() {
  try {
    const response = await fetch('/api/auth/magic/config');
    const config = await response.json();

    if (config.enabled) {
      magic = new Magic(config.publishableKey);
    }
  } catch (error) {
    console.error('Failed to initialize Magic.link:', error);
  }
}

// Check if user is authenticated
async function checkAuth() {
  try {
    const response = await fetch('/api/auth/user');
    const data = await response.json();

    if (!data.authenticated) {
      // Not authenticated - redirect to login
      console.log('User not authenticated, redirecting to login...');
      window.location.href = '/login.html';
      return null;
    }

    currentUser = data.user;
    return data.user;
  } catch (error) {
    console.error('Auth check failed:', error);
    window.location.href = '/login.html';
    return null;
  }
}

// Update UI with user info
function updateUserUI(user) {
  const userEmailEl = document.getElementById('user-email');
  if (userEmailEl && user.email) {
    userEmailEl.textContent = user.email;
  } else if (userEmailEl) {
    userEmailEl.textContent = user.displayName || 'User';
  }
}

// Handle logout
async function handleLogout() {
  try {
    const didToken = sessionStorage.getItem('magicDidToken');

    // Call backend logout
    await fetch('/api/auth/magic/logout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ didToken: didToken || null }),
    });

    // Logout from Magic.link if available
    if (magic) {
      await magic.user.logout();
    }

    // Clear stored token
    sessionStorage.removeItem('magicDidToken');

    // Redirect to login
    window.location.href = '/login.html';
  } catch (error) {
    console.error('Logout error:', error);
    // Redirect anyway
    window.location.href = '/login.html';
  }
}

// Setup profile dropdown toggle
function setupProfileDropdown() {
  const profileToggle = document.getElementById('profile-menu-toggle');
  const profileDropdown = document.getElementById('profile-dropdown');
  const logoutButton = document.getElementById('logout-button');
  const addBlogDropdownBtn = document.getElementById('add-blog-dropdown');
  const addBlogNavBtn = document.getElementById('add-blog-nav');

  if (profileToggle && profileDropdown) {
    profileToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const isHidden = profileDropdown.hasAttribute('hidden');
      if (isHidden) {
        profileDropdown.removeAttribute('hidden');
      } else {
        profileDropdown.setAttribute('hidden', '');
      }
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
      if (!profileDropdown.contains(e.target) && e.target !== profileToggle) {
        profileDropdown.setAttribute('hidden', '');
      }
    });
  }

  if (logoutButton) {
    logoutButton.addEventListener('click', handleLogout);
  }

  // Wire up the dropdown "Add" button to trigger the same modal as navbar button
  if (addBlogDropdownBtn && addBlogNavBtn) {
    addBlogDropdownBtn.addEventListener('click', () => {
      addBlogNavBtn.click();
      // Close dropdown
      if (profileDropdown) {
        profileDropdown.setAttribute('hidden', '');
      }
    });
  }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
  console.log('🔐 Checking authentication...');

  await initMagic();
  const user = await checkAuth();

  if (user) {
    console.log('✅ User authenticated:', user.email || user.displayName);
    updateUserUI(user);
    setupProfileDropdown();
  }
});
