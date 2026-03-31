/** @type {import('tailwindcss').Config} */
/** Manual de identidad visual Dr. Liber Acosta — 2026 */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        brand: {
          authority: '#0c3859',
          clinical: '#7ab4d4',
          immune: '#4db6a2',
          technical: '#2a3b47',
          breath: '#f5f9fa',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        display: ['Outfit', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
