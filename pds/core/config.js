// Supabase project connection constants — anon/publishable key only.
// Safe to expose client-side: RLS (see /supabase/policies) is what actually
// protects data, not secrecy of this key. Never put a service_role key here
// or anywhere outside /supabase/functions.
//
// Single source for both the extension and the web app — update these two
// values when switching Supabase projects, nowhere else.
export const SUPABASE_URL = 'https://fqnoxcycqnnflwdgczvi.supabase.co';
export const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZxbm94Y3ljcW5uZmx3ZGdjenZpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYxMDcyNDksImV4cCI6MjA5MTY4MzI0OX0.Yt650ApLSjA-6g7V5ule168Y7kmmkNmGe3s-dkOshUo';

// Production web app, deployed on Vercel with /web as the project root
// (so dashboard.html is served at the domain root, not under /web/).
// Used by the extension popup's "Manage blocklist" link.
export const DASHBOARD_URL = 'https://pleasedontscroll.com/dashboard.html';

// Used by the popup's locked-Strict-Mode upsell — clicking it opens this.
export const PRICING_URL = 'https://pleasedontscroll.com/pricing.html';

// For local dev against a `python3 -m http.server 8000` run from the repo
// root (pds/), swap the two exports above for:
//   export const DASHBOARD_URL = 'http://localhost:8000/web/dashboard.html';
//   export const PRICING_URL   = 'http://localhost:8000/web/pricing.html';
