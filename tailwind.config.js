/** @type {import('tailwindcss').Config} */
module.exports = {
  // Paths are relative to the project root (this file's location),
  // not to www/ — since the config now lives one level above www/.
  content: [
    "./www/index.html",
    "./www/js/**/*.js"
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#f0f9f4",
          100: "#dcf0e6",
          200: "#bbe1ce",
          300: "#8ecaae",
          400: "#5dac88",
          500: "#3a9070",
          600: "#2a7459",
          700: "#235e48",
          800: "#1e4b3b",
          900: "#1a3e32"
        }
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"]
      }
    }
  },
  plugins: []
};