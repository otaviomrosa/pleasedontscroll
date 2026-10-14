import { parseBlocklistEntry, normalizeToHostname } from '../core/blocklist/hostname.js'

export const QUICK_ADD_SITES = [
  { name: 'Instagram', hostname: 'instagram.com', icon: '<path d="M4 8a4 4 0 0 1 4 -4h8a4 4 0 0 1 4 4v8a4 4 0 0 1 -4 4h-8a4 4 0 0 1 -4 -4l0 -8" /><path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0" /><path d="M16.5 7.5v.01" />', sections: [
    { label: 'Reels', path: '/reels' },
  ] },
  { name: 'YouTube', hostname: 'youtube.com', icon: '<path d="M2 8a4 4 0 0 1 4 -4h12a4 4 0 0 1 4 4v8a4 4 0 0 1 -4 4h-12a4 4 0 0 1 -4 -4v-8" /><path d="M10 9l5 3l-5 3l0 -6" />', sections: [
    { label: 'Shorts', path: '/shorts' },
  ] },
  { name: 'Facebook', hostname: 'facebook.com', icon: '<path d="M7 10v4h3v7h4v-7h3l1 -4h-4v-2a1 1 0 0 1 1 -1h3v-4h-3a5 5 0 0 0 -5 5v2h-3" />', sections: [
    { label: 'Reels', path: '/reels' },
    { label: 'Marketplace', path: '/marketplace' },
  ] },
]

const GLOBE_ICON = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6"/><ellipse cx="12" cy="12" rx="4" ry="9" stroke="currentColor" stroke-width="1.6"/><line x1="3" y1="12" x2="21" y2="12" stroke="currentColor" stroke-width="1.6"/></svg>'
const X_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6L18 18M18 6L6 18" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>'
const LOCK_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" stroke="currentColor" stroke-width="2.5"/><path d="M8 11V7a4 4 0 018 0v4" stroke="currentColor" stroke-width="2.5"/></svg>'
const CHEVRON_ICON = '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>'

export function createUrlItem(url, { locked = false, onRemove, onLocked } = {}) {
  const li = document.createElement('li')
  li.className = 'url-item'

  const left = document.createElement('div')
  left.className = 'url-left'

  const favicon = document.createElement('img')
  favicon.className = 'url-favicon'
  favicon.src = `https://icons.duckduckgo.com/ip3/${normalizeToHostname(url)}.ico`
  favicon.alt = ''
  favicon.addEventListener('error', () => {
    const fallback = document.createElement('span')
    fallback.className = 'url-favicon-fallback'
    fallback.innerHTML = GLOBE_ICON
    favicon.replaceWith(fallback)
  }, { once: true })

  const text = document.createElement('span')
  text.className = 'url-text'
  text.textContent = url
  text.title = url

  left.append(favicon, text)
  li.appendChild(left)

  const del = document.createElement('button')
  del.type = 'button'
  del.className = 'btn-delete-url'
  if (locked) {
    del.classList.add('locked')
    del.title = 'Locked until the Strict session ends'
    del.innerHTML = LOCK_ICON
    del.addEventListener('click', () => onLocked?.(del))
  } else {
    del.title = 'Remove'
    del.setAttribute('aria-label', `Remove ${url}`)
    del.innerHTML = X_ICON
    del.addEventListener('click', () => onRemove?.(url, del))
  }
  li.appendChild(del)
  return li
}

export function closeAllSiteMenus() {
  document.querySelectorAll('.site-options-menu.open').forEach((el) => el.classList.remove('open'))
  document.querySelectorAll('.menu-open').forEach((el) => el.classList.remove('menu-open'))
}

document.addEventListener('click', closeAllSiteMenus)

export function renderQuickAdd(row, urls, { onAdd, onBlockSite }) {
  const entries = urls.map((url) => parseBlocklistEntry(url))
  row.replaceChildren()

  for (const site of QUICK_ADD_SITES) {
    const wholeDomainAdded = entries.some((entry) => entry.hostname === site.hostname && entry.pathPrefix === null)
    const hasSections = !wholeDomainAdded && site.sections.length > 0

    const item = document.createElement('div')
    item.className = 'quick-add-item'

    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'quick-add-chip' + (wholeDomainAdded ? ' added' : '')
    chip.title = hasSections ? `${site.name} options` : (wholeDomainAdded ? `${site.name} blocked` : `Block ${site.name}`)
    chip.setAttribute('aria-label', chip.title)
    chip.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${site.icon}</svg><span></span>${hasSections ? CHEVRON_ICON : ''}`
    chip.querySelector('span').textContent = site.name
    item.appendChild(chip)

    if (hasSections) {
      const menu = document.createElement('div')
      menu.className = 'site-options-menu'
      const inner = document.createElement('div')
      inner.className = 'site-options-menu-inner'
      menu.appendChild(inner)

      const base = document.createElement('button')
      base.type = 'button'
      base.className = 'site-options-menu-item'
      base.textContent = `Block ${site.name}`
      base.addEventListener('click', () => onBlockSite(site, base))
      inner.appendChild(base)

      for (const section of site.sections) {
        const added = entries.some((entry) => entry.hostname === site.hostname && entry.pathPrefix === section.path)
        const option = document.createElement('button')
        option.type = 'button'
        option.className = added ? 'site-options-menu-item added' : 'site-options-menu-item'
        option.textContent = added ? `${section.label} blocked` : `Block ${section.label}`
        if (!added) option.addEventListener('click', () => onAdd(`${site.hostname}${section.path}`, `${site.name} ${section.label}`, option))
        inner.appendChild(option)
      }
      item.appendChild(menu)

      chip.addEventListener('click', (event) => {
        event.stopPropagation()
        const open = menu.classList.contains('open')
        closeAllSiteMenus()
        if (!open) {
          menu.classList.add('open')
          chip.classList.add('menu-open')
        }
      })
    } else if (!wholeDomainAdded) {
      chip.addEventListener('click', () => onAdd(site.hostname, site.name, chip))
    }

    row.appendChild(item)
  }
}
