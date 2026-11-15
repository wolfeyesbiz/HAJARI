/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        navy: {
          50: '#f2f6fc', 100: '#e2eaf7', 200: '#c9d9ef', 300: '#a3bfe3',
          400: '#759dd4', 500: '#547fc7', 600: '#4166b0', 700: '#36548f',
          800: '#1e3a6e', 900: '#12294f', 950: '#0b1a33',
        },
        cyan: {
          50: '#ecfeff', 100: '#cffafe', 200: '#a5f3fc', 300: '#67e8f9',
          400: '#22d3ee', 500: '#06b6d4', 600: '#0891b2', 700: '#0e7490',
        },
        present: '#16a34a',
        absent: '#dc2626',
        leave: '#d97706',
      },
      boxShadow: {
        card: '0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.1)',
        pop: '0 12px 32px rgba(16,24,40,.16)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
