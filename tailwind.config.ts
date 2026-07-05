import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}"
  ],
  theme: {
    extend: {
      colors: {
        ink: "#172033",
        muted: "#667085",
        line: "#d9e0e8",
        canvas: "#f6f8fb",
        brand: {
          blue: "#1f6feb",
          green: "#12a150",
          cyan: "#0c8ea6"
        }
      },
      boxShadow: {
        panel: "0 18px 50px rgba(23, 32, 51, 0.08)"
      }
    }
  },
  plugins: []
};

export default config;

