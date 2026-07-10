import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pianote — 들으며 배우는 피아노",
  description: "실제 피아노 소리를 듣고 다음 음을 안내하는 인터랙티브 피아노 연습 도구",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko"><body>{children}</body></html>;
}
