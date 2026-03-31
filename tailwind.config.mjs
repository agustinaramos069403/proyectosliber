/** @type {import('tailwindcss').Config} */
/** Manual de identidad — isotipo LA sobre #003355 */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        brand: {
          authority: '#003355',
          authorityHover: '#004872',
          authorityMuted: 'rgba(0, 51, 85, 0.12)',
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
          '0 0 0 1px rgba(0, 51, 85, 0.22), 0 0 0 3px rgba(245, 249, 250, 1), 0 4px 20px rgba(0, 51, 85, 0.07)',
      },
    },
  },
  plugins: [],
};
