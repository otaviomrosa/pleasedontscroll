import { parseBlocklistEntry, entryCovers, isValidBlocklistUrl, isOwnDomain } from '../core/blocklist/hostname.js'
import { formatCountdown } from '../core/session/time.js'

const $ = (id) => document.getElementById(id)
const X_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>'

function segmented(el, onChange) {
  if (!el) return
  el.addEventListener('click', (event) => {
    const btn = event.target.closest('button')
    if (!btn || el.classList.contains('is-frozen')) return
    el.querySelectorAll('button').forEach((b) => b.classList.toggle('is-on', b === btn))
    onChange?.(btn.dataset.v ?? btn.textContent.trim(), btn)
  })
}

function siteRow(url, onRemove) {
  const entry = parseBlocklistEntry(url)
  const li = document.createElement('li')
  li.className = 'site'
  const icon = document.createElement('span')
  icon.className = 'site__icon'
  icon.textContent = entry.hostname.charAt(0)
  const name = document.createElement('span')
  name.className = 'site__name'
  name.textContent = entry.hostname
  if (entry.pathPrefix) {
    const path = document.createElement('span')
    path.className = 'site__path'
    path.textContent = entry.pathPrefix
    name.appendChild(path)
  }
  li.append(icon, name)
  if (onRemove) {
    const x = document.createElement('button')
    x.type = 'button'
    x.className = 'site__x'
    x.setAttribute('aria-label', `Remove ${url}`)
    x.innerHTML = X_ICON
    x.addEventListener('click', () => onRemove(url))
    li.appendChild(x)
  }
  return li
}

const profiles = {
  Default: ['instagram.com', 'x.com'],
  'Deep work': ['youtube.com/shorts', 'instagram.com', 'x.com', 'reddit.com'],
  Evening: ['netflix.com', 'tiktok.com'],
}
let profile = 'Deep work'

const QUICK = [
  { label: 'Shorts', url: 'youtube.com/shorts' },
  { label: 'Reels', url: 'instagram.com/reels' },
  { label: 'TikTok', url: 'tiktok.com' },
  { label: 'Reddit', url: 'reddit.com' },
]

function addSite(url) {
  const list = profiles[profile]
  const entry = parseBlocklistEntry(url)
  if (list.some((u) => entryCovers(parseBlocklistEntry(u), entry))) return false
  profiles[profile] = list.filter((u) => !entryCovers(entry, parseBlocklistEntry(u))).concat(url)
  return true
}

function renderDashboard() {
  const ul = $('d-sites')
  if (!ul) return
  ul.replaceChildren(...profiles[profile].map((url) => siteRow(url, (u) => {
    profiles[profile] = profiles[profile].filter((x) => x !== u)
    renderDashboard()
  })))
  $('d-count').textContent = String(profiles[profile].length)
  const quick = $('d-quick')
  quick.querySelectorAll('.quick__chip').forEach((c) => c.remove())
  for (const q of QUICK) {
    const covered = profiles[profile].some((u) => entryCovers(parseBlocklistEntry(u), parseBlocklistEntry(q.url)))
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'quick__chip'
    chip.disabled = covered
    chip.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>'
    chip.append(q.label)
    chip.addEventListener('click', () => { addSite(q.url); renderDashboard() })
    quick.appendChild(chip)
  }
  $('p-profile').textContent = profile
}

$('d-tabs')?.addEventListener('click', (event) => {
  const btn = event.target.closest('button')
  if (!btn || session) return
  profile = btn.dataset.p
  $('d-tabs').querySelectorAll('button').forEach((b) => b.classList.toggle('is-on', b === btn))
  renderDashboard()
})

$('d-form')?.addEventListener('submit', (event) => {
  event.preventDefault()
  const input = $('d-input')
  const value = input.value.trim().toLowerCase()
  if (!value || !isValidBlocklistUrl(value) || isOwnDomain(value) || !addSite(value)) {
    input.classList.remove('shake')
    void input.offsetWidth
    input.classList.add('shake')
    return
  }
  input.value = ''
  renderDashboard()
})

let mode = 'friction'
let minutes = 30
let session = null
let ticker = null
let armedUntil = 0

function renderPopup() {
  const dial = $('p-dial')
  if (!dial) return
  const running = session !== null
  dial.classList.toggle('is-idle', !running)
  dial.classList.toggle('is-strict', mode === 'strict')
  $('p-mode').classList.toggle('is-frozen', running)
  $('p-len').classList.toggle('is-frozen', running)
  const btn = $('p-btn')
  const chip = $('d-chip')
  chip.classList.toggle('is-idle', !running)
  chip.classList.toggle('is-strict', running && mode === 'strict')
  if (!running) {
    $('p-label').textContent = 'Ready when you are'
    $('p-time').textContent = formatCountdown(minutes * 60000)
    $('p-sub').textContent = mode === 'strict' ? 'No way out until it ends' : 'Breathe to open a site'
    $('p-fill').style.strokeDashoffset = '0'
    btn.className = 'btn btn--primary'
    btn.textContent = 'Start focusing'
    btn.disabled = false
    $('d-chip-text').textContent = 'No session'
    return
  }
  const remaining = Math.max(0, session.until - Date.now())
  $('p-label').textContent = mode === 'strict' ? 'Strict session' : 'Friction session'
  $('p-time').textContent = formatCountdown(remaining)
  const end = new Date(session.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  $('p-sub').textContent = `until ${end}`
  $('p-fill').style.strokeDashoffset = String(1000 * (1 - remaining / session.total))
  $('d-chip-text').textContent = mode === 'strict' ? 'Strict session' : 'Friction session'
  if (mode === 'strict') {
    btn.className = 'btn btn--secondary'
    btn.disabled = false
    btn.textContent = 'Locked until ' + end
  } else {
    const armed = Date.now() < armedUntil
    btn.className = `btn btn--danger${armed ? ' is-armed' : ''}`
    btn.disabled = false
    btn.textContent = armed ? 'Click again to end' : 'End session'
  }
}

segmented($('p-mode'), (v) => { mode = v; renderPopup() })
segmented($('p-len'), (v) => { minutes = Number(v); renderPopup() })

$('p-btn')?.addEventListener('click', () => {
  if (!session) {
    session = { until: Date.now() + minutes * 60000, total: minutes * 60000 }
    $('p-note').textContent = `${profiles[profile].length} sites blocked on ${profile}`
    clearInterval(ticker)
    ticker = setInterval(() => {
      if (session && Date.now() >= session.until) session = null
      renderPopup()
    }, 1000)
    renderPopup()
    return
  }
  if (mode === 'strict') {
    $('p-note').textContent = 'This is the demo, so here you can.'
    setTimeout(() => { session = null; $('p-note').textContent = 'Try it. Nothing gets blocked here.'; renderPopup() }, 1400)
    return
  }
  if (Date.now() >= armedUntil) {
    armedUntil = Date.now() + 3000
    setTimeout(renderPopup, 3000)
    renderPopup()
    return
  }
  armedUntil = 0
  session = null
  $('p-note').textContent = 'Session ended.'
  renderPopup()
})

let focusMode = 'friction'
let breath = null

function renderFocus() {
  if (!$('f-ring')) return
  const strict = focusMode === 'strict'
  $('f-chip').classList.toggle('is-strict', strict)
  $('f-chip-text').textContent = strict ? 'Strict session' : 'Friction session'
  $('f-ring').classList.toggle('is-strict', strict)
  $('f-breathe').hidden = strict || breath !== null
  $('f-fine').textContent = strict ? 'Strict Mode is on until 4:30 PM.' : ''
  if (breath === null) {
    $('f-title').textContent = 'youtube.com is blocked'
    $('f-lead').textContent = 'It opens again when your session ends.'
    $('f-time').textContent = '18:38'
    $('f-sub').textContent = 'left in this session'
    $('f-fill').style.strokeDashoffset = '380'
  }
}

segmented($('f-mode'), (v) => {
  focusMode = v
  clearInterval(breath)
  breath = null
  renderFocus()
})

$('f-breathe')?.addEventListener('click', () => {
  let left = 30
  $('f-title').textContent = 'Take a breath'
  $('f-lead').textContent = 'Stay for 30 seconds, then decide if you still want it.'
  $('f-time').textContent = '30'
  $('f-sub').textContent = 'breathe in'
  $('f-fill').style.strokeDashoffset = '0'
  breath = setInterval(() => {
    left -= 1
    $('f-time').textContent = String(left)
    $('f-sub').textContent = Math.floor((30 - left) / 4) % 2 === 0 ? 'breathe in' : 'breathe out'
    $('f-fill').style.strokeDashoffset = String(1000 * (1 - left / 30))
    if (left <= 0) {
      clearInterval(breath)
      $('f-title').textContent = 'Go ahead, mindfully'
      $('f-lead').textContent = 'youtube.com is open for 10 minutes.'
      $('f-sub').textContent = 'done'
      setTimeout(() => { breath = null; renderFocus() }, 2600)
    }
  }, 1000)
  renderFocus()
})

$('f-back')?.addEventListener('click', () => {
  clearInterval(breath)
  breath = null
  renderFocus()
})

const modeLists = {
  friction: ['youtube.com/shorts', 'x.com'],
  strict: ['instagram.com', 'reddit.com'],
}

function renderModeList(v) {
  const ul = $('m-list')
  if (ul) ul.replaceChildren(...modeLists[v].map((u) => siteRow(u)))
}

segmented($('m-mode'), renderModeList)
segmented($('pr-row'))
segmented($('len-demo'))

renderModeList('friction')
renderDashboard()
renderPopup()
renderFocus()
