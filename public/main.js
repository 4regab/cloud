const config = window.BRYL_CONFIG || {};
const assetBaseUrl = (config.assetBaseUrl || "/assets").replace(/\/$/, "");

const assetUrl = (path) => `${assetBaseUrl}/${path.replace(/^\//, "")}`;

document.querySelectorAll(".asset").forEach((element) => {
  element.src = assetUrl(element.dataset.asset);
});

const themeToggle = document.querySelector(".theme-toggle");
themeToggle?.addEventListener("click", () => {
  const isDark = document.documentElement.classList.toggle("dark");
  localStorage.setItem("theme", isDark ? "dark" : "light");
});

const awardToggle = document.querySelector(".award button");
const awardDetails = document.querySelector(".award-details");
awardToggle?.addEventListener("click", () => {
  awardDetails.hidden = !awardDetails.hidden;
});

const recommendations = [
  {
    text: "“Bryl was the most talented software engineer I've mentored in a long time. He's a fast learner, and he always makes sure to deliver quality output given a period of time. He is also very keen on learning new technologies, and I find him to be objectively...”",
    name: "Cris Lawrence Adrian Militante",
    role: "ICT Director at GCM"
  },
  {
    text: "“Sir Bryl's teaching approach is incredibly hands-on, and the projects significantly accelerated my learning process in web development. I am truly grateful for the mentorship I received from him during my web development internship.”",
    name: "John Edmerson Pizarra",
    role: "Jr. Full-stack Developer, PocketDevs"
  },
  {
    text: "“Bryl brings a rare mix of technical depth, mentorship, and practical execution. He explains complex engineering work clearly and ships with strong attention to detail.”",
    name: "Portfolio Visitor",
    role: "Recommendation"
  }
];

const recommendationText = document.querySelector("#recommendation-text");
const recommendationName = document.querySelector("#recommendation-name");
const recommendationRole = document.querySelector("#recommendation-role");
const recommendationDots = document.querySelector("#recommendation-dots");
let recommendationIndex = 0;

function renderRecommendation(index) {
  const recommendation = recommendations[index];
  recommendationText.textContent = recommendation.text;
  recommendationName.textContent = recommendation.name;
  recommendationRole.textContent = recommendation.role;
  recommendationDots.innerHTML = "";
  recommendations.forEach((_, dotIndex) => {
    const button = document.createElement("button");
    button.type = "button";
    button.ariaLabel = `Show recommendation ${dotIndex + 1}`;
    button.className = dotIndex === index ? "active" : "";
    button.addEventListener("click", () => {
      recommendationIndex = dotIndex;
      renderRecommendation(recommendationIndex);
    });
    recommendationDots.append(button);
  });
}

renderRecommendation(recommendationIndex);
setInterval(() => {
  recommendationIndex = (recommendationIndex + 1) % recommendations.length;
  renderRecommendation(recommendationIndex);
}, 9000);

const galleryTrack = document.querySelector("#gallery-track");
const galleryImages = [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15];
let galleryOffset = 0;

function renderGallery() {
  galleryTrack.innerHTML = "";
  galleryImages.forEach((imageNumber) => {
    const img = document.createElement("img");
    img.src = assetUrl(`gallery/gallery-${imageNumber}.webp`);
    img.alt = `Gallery image ${imageNumber}`;
    img.loading = "lazy";
    galleryTrack.append(img);
  });
  galleryTrack.style.transform = `translateX(-${galleryOffset}px)`;
  document.querySelector(".gallery-prev").disabled = galleryOffset <= 0;
}

function moveGallery(direction) {
  const firstImage = galleryTrack.querySelector("img");
  const step = firstImage ? firstImage.getBoundingClientRect().width + 10 : 230;
  const maxOffset = Math.max(0, galleryTrack.scrollWidth - galleryTrack.parentElement.clientWidth);
  galleryOffset = Math.max(0, Math.min(maxOffset, galleryOffset + direction * step));
  galleryTrack.style.transform = `translateX(-${galleryOffset}px)`;
  document.querySelector(".gallery-prev").disabled = galleryOffset <= 0;
}

document.querySelector(".gallery-prev")?.addEventListener("click", () => moveGallery(-1));
document.querySelector(".gallery-next")?.addEventListener("click", () => moveGallery(1));
window.addEventListener("resize", () => {
  galleryOffset = 0;
  renderGallery();
});
renderGallery();

const chatLauncher = document.querySelector(".chat-launcher");
const chatPanel = document.querySelector(".chat-panel");
const chatClose = document.querySelector(".chat-head button");
const chatForm = document.querySelector(".chat-form");
const chatLog = document.querySelector("#chat-log");
const chatMessages = [];

chatLauncher?.addEventListener("click", () => {
  chatPanel.hidden = !chatPanel.hidden;
});

chatClose?.addEventListener("click", () => {
  chatPanel.hidden = true;
});

function addChatMessage(role, text) {
  const bubble = document.createElement("p");
  bubble.className = role;
  bubble.textContent = text;
  chatLog.append(bubble);
  chatLog.scrollTop = chatLog.scrollHeight;
}

chatForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = chatForm.elements.message;
  const message = input.value.trim();
  if (!message) return;

  input.value = "";
  addChatMessage("user", message);
  chatMessages.push({ role: "user", text: message });
  const pending = document.createElement("p");
  pending.className = "assistant pending";
  pending.textContent = "Thinking...";
  chatLog.append(pending);

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: chatMessages })
    });
    const payload = await response.json();
    const reply = response.ok ? payload.reply : payload.error;
    pending.textContent = reply || "I could not respond right now.";
    chatMessages.push({ role: "assistant", text: pending.textContent });
  } catch {
    pending.textContent = "Chat is unavailable right now. Please email bryllim@gmail.com.";
  }
});
