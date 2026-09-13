/** @type {import('tailwindcss').Config} */
export default {
  content: ["./public/index.html", "./public/app.js"],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      fontFamily: { sans: ["Vazirmatn", "sans-serif"] },
      colors: {
        // رنگ برند از متغیرهای CSS خوانده می‌شود تا پالت قابل تعویض باشد
        brand: {
          DEFAULT: "rgb(var(--brand) / <alpha-value>)",
          dark: "rgb(var(--brand-dark) / <alpha-value>)",
          light: "rgb(var(--brand-light) / <alpha-value>)",
          50: "rgb(var(--brand-50) / <alpha-value>)",
          100: "rgb(var(--brand-100) / <alpha-value>)",
          200: "rgb(var(--brand-200) / <alpha-value>)",
          500: "rgb(var(--brand-500) / <alpha-value>)",
          600: "rgb(var(--brand-600) / <alpha-value>)",
          700: "rgb(var(--brand-700) / <alpha-value>)",
        },
        ink: "#0f172a",
        muted: "#64748b",
      },
    },
  },
  plugins: [],
};
