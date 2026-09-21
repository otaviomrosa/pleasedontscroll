// Shared behavior for the marketing pages: signed-in account menu and the
// scroll reveal. Imports the same /core modules the existing pages use, so
// session state is shared with the dashboard and the extension.
import { webStorageAdapter } from '../core/auth/storage.js'
import * as Auth from '../core/auth/session.js'
import { DASHBOARD_URL } from '../core/config.js'

// A recovery / signup / error hash that lands here instead of on the
// dashboard is forwarded there, since only dashboard.html knows how to read
// it (same defensive hop the current index.html does).
if (/(^|&)(access_token|error)=/.test(window.location.hash.replace(/^#/, ''))) {
  window.location.replace(DASHBOARD_URL + window.location.hash)
}

export async function initAccountMenu() {
  const navCta = document.getElementById('nav-cta')
  const menu   = document.getElementById('account-menu')
  if (!navCta || !menu) return

  const accessToken = await Auth.getValidAccessToken(webStorageAdapter)
  if (!accessToken) {
    menu.classList.add('hidden')
    navCta.classList.remove('hidden')
    return
  }

  const session = await Auth.getStoredSession(webStorageAdapter)
  navCta.classList.add('hidden')
  menu.classList.remove('hidden')
  document.getElementById('account-email').textContent = session.user.email
  document.getElementById('account-avatar-btn').textContent =
    session.user.email.charAt(0).toUpperCase()
}

const avatarBtn = document.getElementById('account-avatar-btn')
if (avatarBtn) {
  avatarBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    document.getElementById('account-dropdown').classList.toggle('open')
  })
  document.addEventListener('click', () => {
    document.getElementById('account-dropdown').classList.remove('open')
  })
  document.getElementById('account-signout-btn').addEventListener('click', async () => {
    await Auth.signOut(webStorageAdapter)
    window.location.href = 'index.html'
  })
}

initAccountMenu()

// The landing page's .prelude backdrop runs behind the top of the document,
// and .nav's opaque background would punch a white strip through it. So the
// nav goes transparent, but only while the page is parked at the very top:
// the moment anything scrolls, content would otherwise slide through it.
// Opaque is the CSS default, so this only ever removes the background, never
// adds it. If this script fails to run the nav stays readable.
if (document.querySelector('.prelude')) {
  const nav = document.querySelector('.nav')
  if (nav) {
    const sync = () => nav.classList.toggle('nav--over', window.scrollY < 8)
    sync()
    window.addEventListener('scroll', sync, { passive: true })
  }
}

// Scroll reveal. The .reveal class (which hides an element until it is
// in view) is only ever added here, inside the same reduced-motion check
// the CSS uses, so a visitor with that preference never has content hidden
// by JS, not even for a frame.
if (window.matchMedia('(prefers-reduced-motion: no-preference)').matches && 'IntersectionObserver' in window) {
  const els = document.querySelectorAll('[data-reveal]')
  els.forEach((el) => el.classList.add('reveal'))
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return
      entry.target.classList.add('in-view')
      io.unobserve(entry.target)
    })
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' })
  els.forEach((el) => io.observe(el))
}

export function showToast(msg, duration = 3500) {
  const el = document.getElementById('toast')
  if (!el) return
  el.textContent = msg
  el.classList.add('visible')
  clearTimeout(showToast._t)
  showToast._t = setTimeout(() => el.classList.remove('visible'), duration)
}
