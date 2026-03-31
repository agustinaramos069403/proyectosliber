/** @type {import('tailwindcss').Config} */
/** Manual de identidad — isotipo LA sobre verde/teal */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        brand: {
          authority: '#0b3f3c',
          authorityHover: '#0f5450',
          authorityMuted: 'rgba(11, 63, 60, 0.12)',
          clinical: '#8bd6cb',
          immune: '#4fb7a7',
          technical: '#203333',
          breath: '#f3fbfa',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        display: ['Outfit', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        line:
          '0 0 0 1px rgba(11, 63, 60, 0.22), 0 0 0 3px rgba(243, 251, 250, 1), 0 6px 24px rgba(11, 63, 60, 0.08)',
      },
    },
  },
  plugins: [],
};
