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
      boxShadow: {
        line:
          '0 0 0 1px rgba(11, 61, 89, 0.18), 0 0 0 3px rgba(245, 249, 250, 1), 0 4px 20px rgba(11, 61, 89, 0.06)',
      },
    },
  },
  plugins: [],
};
