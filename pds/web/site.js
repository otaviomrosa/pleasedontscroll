import { webStorageAdapter } from '../core/auth/storage.js'
import * as Auth from '../core/auth/session.js'
import { DASHBOARD_URL } from '../core/config.js'

if (/(^|&)(access_token|error)=/.test(window.location.hash.replace(/^#/, ''))) {
  window.location.replace(DASHBOARD_URL + window.location.hash)
}

export async function initAccountMenu() {
  const menu = document.getElementById('account-menu')
  if (!menu) return null
  const accessToken = await Auth.getValidAccessToken(webStorageAdapter)
  if (!accessToken) return null

  const session = await Auth.getStoredSession(webStorageAdapter)
  menu.hidden = false
  document.querySelectorAll('[data-signed-out]').forEach((el) => { el.hidden = true })
  document.querySelectorAll('[data-signed-in]').forEach((el) => { el.hidden = false })
  document.getElementById('account-email').textContent = session.user.email
  document.getElementById('account-avatar-btn').textContent = session.user.email.charAt(0).toUpperCase()
  return session
}

const avatarBtn = document.getElementById('account-avatar-btn')
if (avatarBtn) {
  const dropdown = document.getElementById('account-dropdown')
  avatarBtn.addEventListener('click', (event) => {
    event.stopPropagation()
    dropdown.classList.toggle('open')
    avatarBtn.setAttribute('aria-expanded', String(dropdown.classList.contains('open')))
  })
  document.addEventListener('click', () => dropdown.classList.remove('open'))
  document.getElementById('account-signout-btn').addEventListener('click', async () => {
    await Auth.signOut(webStorageAdapter)
    window.location.href = 'index.html'
  })
}

export const accountReady = initAccountMenu()

const header = document.querySelector('.header')
if (header) {
  const sync = () => header.classList.toggle('is-scrolled', window.scrollY > 24)
  sync()
  window.addEventListener('scroll', sync, { passive: true })
}

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
  clearTimeout(showToast.timer)
  showToast.timer = setTimeout(() => el.classList.remove('visible'), duration)
}
