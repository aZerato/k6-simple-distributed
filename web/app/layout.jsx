import './globals.css';

// Police identique à la console legacy (Chakra Petch / IBM Plex).
const FONT_LINK = (
  <link
    href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap"
    rel="stylesheet"
  />
);

export const metadata = {
  title: 'k6 Orchestrator — Console'
};

export default function RootLayout({ children }) {
  return (
    <html lang="fr">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {FONT_LINK}
      </head>
      <body>{children}</body>
    </html>
  );
}
