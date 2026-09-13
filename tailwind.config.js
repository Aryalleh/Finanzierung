/** @type {import('tailwindcss').Config} */
export default {
  content: ["./public/index.html", "./public/app.js"],
  theme: {
    extend: {
      fontFamily: { sans: ["Vazirmatn", "sans-serif"] },
      colors: {
        brand: {
          DEFAULT: "#0f766e", dark: "#0d5f58", light: "#14b8a6",
          50: "#f0fdfa", 100: "#ccfbf1", 200: "#99f6e4",
          500: "#14b8a6", 600: "#0d9488", 700: "#0f766e",
        },
        ink: "#0f172a",
        muted: "#64748b",
      },
    },
  },
  plugins: [],
};
