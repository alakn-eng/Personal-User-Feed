// Gmail button component - only rendered if feature flag is enabled
const GMAIL_AUTH_ENDPOINT = "/integrations/gmail/auth";

async function initGmailButton() {
  // Check if Gmail feature is enabled via API
  try {
    const response = await fetch("/api/config");
    const config = await response.json();

    if (!config.features?.gmail) {
      console.log("Gmail feature is disabled");
      return;
    }
  } catch (error) {
    console.error("Failed to check Gmail feature flag:", error);
    return;
  }

  // Find the YouTube button and add Gmail button next to it
  const youtubeButton = document.querySelector("#youtube-auth");
  if (!youtubeButton) {
    console.warn("YouTube button not found, cannot add Gmail button");
    return;
  }

  // Create Gmail button
  const gmailButton = document.createElement("button");
  gmailButton.className = "gmail-connect";
  gmailButton.id = "gmail-auth";
  gmailButton.type = "button";
  gmailButton.textContent = "Connect Gmail";

  gmailButton.addEventListener("click", () => {
    window.location.href = GMAIL_AUTH_ENDPOINT;
  });

  // Insert after YouTube button
  youtubeButton.after(gmailButton);

  // Check if user has already connected Gmail
  await checkGmailConnection(gmailButton);
}

async function checkGmailConnection(button) {
  try {
    const response = await fetch("/api/gmail/status", {
      credentials: "include",
    });

    if (response.ok) {
      const data = await response.json();
      if (data.connected) {
        button.textContent = "Gmail connected";
        button.classList.add("is-connected");
      }
    }
  } catch (error) {
    // Silently fail - user probably hasn't connected yet
    console.log("Gmail not connected");
  }
}

// Initialize when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initGmailButton);
} else {
  initGmailButton();
}

export {};
