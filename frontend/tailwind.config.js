/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx}",
    "./components/**/*.{js,ts,jsx,tsx}",
    "./lib/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        mono: ["JetBrains Mono", "monospace"],
      },
      colors: {
        terminal: {
          bg:      "#0d0d0d",
          surface: "#141414",
          border:  "#1f1f1f",
          cyan:    "#00ffe0",
          green:   "#00ff88",
          yellow:  "#ffd700",
          red:     "#ff4444",
          muted:   "#555555",
          text:    "#e0e0e0",
        },
      },
    },
  },
  plugins: [],
};
