import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import Link from 'next/link'
import type { ReactNode } from 'react'

import { Providers } from './providers'
import './globals.css'

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Polymarket Predictor',
  description:
    'Paper trading simulator for Polymarket — find edges, size positions with Kelly, track performance.',
}

const NAV_LINKS: ReadonlyArray<{ href: string; label: string }> = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/manifold', label: 'Manifold' },
  { href: '/portfolio', label: 'Portfolio' },
  { href: '/performance', label: 'Performance' },
]

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-screen bg-gray-950 text-gray-100 antialiased">
        <Providers>
          <header className="sticky top-0 z-40 border-b border-gray-800/80 bg-gray-950/85 backdrop-blur">
            <nav className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
              <Link
                href="/dashboard"
                className="flex items-center gap-2 text-base font-semibold tracking-tight text-white transition hover:text-emerald-400"
              >
                <span
                  aria-hidden
                  className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.7)]"
                />
                Polymarket Predictor
              </Link>

              <ul className="flex items-center gap-1 text-sm text-gray-300">
                {NAV_LINKS.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className="rounded-md px-3 py-1.5 transition hover:bg-gray-800/70 hover:text-white"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          </header>

          <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
            {children}
          </main>
        </Providers>
      </body>
    </html>
  )
}
