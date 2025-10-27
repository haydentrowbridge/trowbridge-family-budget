/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {},
  },
  safelist: [
    // Guarantees Tailwind always includes these basics
    'bg-gray-50', 'text-gray-900', 'p-4', 'rounded-xl', 'shadow-sm',
    'bg-blue-600', 'hover:bg-blue-700', 'active:bg-blue-800',
    'm-4', 'p-4', 'rounded-xl', 'bg-indigo-200', 'text-indigo-900'
  ],
  plugins: [],
};
