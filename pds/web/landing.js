import { parseBlocklistEntry, entryCovers, isValidBlocklistUrl, isOwnDomain } from '../core/blocklist/hostname.js'
import { formatCountdown, formatClockTime } from '../core/session/time.js'
import { syncSegmented } from './site.js'
import { createUrlItem, renderQuickAdd } from './blocklist-view.js'

const $ = (id) => document.getElementById(id)

function segmented(el, onChange) {
  if (!el) return
  el.addEventListener('click', (event) => {
    const btn = event.target.closest('button')
    if (!btn || el.classList.contains('is-frozen')) return
    el.querySelectorAll('button').forEach((b) => b.classList.toggle('is-on', b === btn))
    syncSegmented(el)
    onChange?.(btn.dataset.v ?? btn.textContent.trim(), btn)
  })
}

const profiles = {
  Default: ['instagram.com', 'x.com'],
  'Deep work': ['youtube.com/shorts', 'instagram.com', 'x.com', 'reddit.com'],
  Evening: ['netflix.com', 'tiktok.com'],
}
let profile = 'Deep work'

function covered(list, url) {
  return list.some((u) => entryCovers(parseBlocklistEntry(u), parseBlocklistEntry(url)))
}

function addSite(url) {
  const list = profiles[profile]
  if (covered(list, url)) return false
  const entry = parseBlocklistEntry(url)
  profiles[profile] = list.filter((u) => !entryCovers(entry, parseBlocklistEntry(u))).concat(url)
  return true
}

function renderDashboard() {
  const ul = $('d-sites')
  if (!ul) return
  ul.replaceChildren(...profiles[profile].map((url) => createUrlItem(url, {
    onRemove: (u) => {
      profiles[profile] = profiles[profile].filter((x) => x !== u)
      renderDashboard()
    },
  })))
  $('d-count').textContent = String(profiles[profile].length)
  $('d-tabs').querySelectorAll('.profile-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.p === profile)
    tab.classList.toggle('running', session !== null && tab.dataset.p === profile)
  })
  renderQuickAdd($('d-quick'), profiles[profile], {
    onAdd: (url) => { addSite(url); renderDashboard() },
    onBlockSite: (site) => { addSite(site.hostname); renderDashboard() },
  })
  $('p-profile').textContent = profile
}

$('d-tabs')?.addEventListener('click', (event) => {
  const btn = event.target.closest('.profile-tab')
  if (!btn || session) return
  profile = btn.dataset.p
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

function renderSessionMirror() {
  const card = $('d-session')
  if (!card) return
  const live = session !== null
  const strict = mode === 'strict'
  card.classList.toggle('is-live', live)
  card.classList.toggle('is-strict', live && strict)
  $('d-ring').classList.toggle('is-idle', !live)
  $('d-ring').classList.toggle('is-strict', live && strict)
  const chip = $('d-chip')
  chip.classList.toggle('is-idle', !live)
  chip.classList.toggle('is-strict', live && strict)
  if (!live) {
    $('d-label').textContent = 'No session'
    $('d-time').textContent = 'Idle'
    $('d-hint').textContent = 'Start one from the popup. Sites are only blocked while it runs.'
    $('d-fill').style.strokeDashoffset = '1000'
    $('d-chip-text').textContent = 'No session'
    return
  }
  const remaining = Math.max(0, session.until - Date.now())
  const label = strict ? 'Strict session' : 'Friction session'
  $('d-label').textContent = label
  $('d-time').textContent = formatCountdown(remaining)
  $('d-hint').textContent = `${profile}, until ${formatClockTime(session.until)}`
  $('d-fill').style.strokeDashoffset = String(1000 * (1 - remaining / session.total))
  $('d-chip-text').textContent = `${label} running`
}

function renderPopup() {
  const dial = $('p-dial')
  if (!dial) return
  const running = session !== null
  dial.classList.toggle('is-idle', !running)
  dial.classList.toggle('is-strict', mode === 'strict')
  $('p-mode').classList.toggle('is-frozen', running)
  $('p-len').classList.toggle('is-frozen', running)
  const btn = $('p-btn')
  const time = $('p-time')
  if (!running) {
    $('p-label').textContent = ''
    time.textContent = formatCountdown(minutes * 60000)
    $('p-sub').textContent = ''
    $('p-fill').style.strokeDashoffset = '0'
    btn.className = 'btn btn--primary'
    btn.textContent = 'Start focusing'
  } else {
    const remaining = Math.max(0, session.until - Date.now())
    $('p-label').textContent = mode === 'strict' ? 'Strict session' : 'Keep going!'
    time.textContent = formatCountdown(remaining)
    $('p-sub').textContent = `until ${formatClockTime(session.until)}`
    $('p-fill').style.strokeDashoffset = String(1000 * (1 - remaining / session.total))
    if (mode === 'strict') {
      btn.className = 'btn btn--secondary'
      btn.textContent = `Locked until ${formatClockTime(session.until)}`
    } else {
      const armed = Date.now() < armedUntil
      btn.className = `btn btn--danger${armed ? ' is-armed' : ''}`
      btn.textContent = armed ? 'Click again to end' : 'End session'
    }
  }
  time.classList.toggle('is-long', time.textContent.length > 5)
  renderSessionMirror()
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
    renderDashboard()
    return
  }
  if (mode === 'strict') {
    $('p-note').textContent = 'This is the demo, so here you can.'
    setTimeout(() => {
      session = null
      $('p-note').textContent = 'Try it. Nothing gets blocked here.'
      renderPopup()
      renderDashboard()
    }, 1400)
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
  renderDashboard()
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
  if (!ul) return
  ul.replaceChildren(...modeLists[v].map((u) => createUrlItem(u, {
    onRemove: () => {
      modeLists[v] = modeLists[v].filter((x) => x !== u)
      renderModeList(v)
    },
  })))
}

segmented($('m-mode'), renderModeList)
segmented($('pr-row'))
segmented($('len-demo'))

renderModeList('friction')
renderDashboard()
renderPopup()
renderFocus()
