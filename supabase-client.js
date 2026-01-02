// Import the Supabase client from the internet
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm'

// 1. YOUR KEYS (Paste them here)
const supabaseUrl = 'https://ixndgaibtxmnfpzliavi.supabase.co'
const supabaseKey = 'sb_publishable_RrdEVWo1HaC7B9yrVGWEIg_d-QXc5-b'

// 2. INITIALIZE THE BRAIN
export const supabase = createClient(supabaseUrl, supabaseKey)

// 3. A SIMPLE TEST LOG
console.log("Supabase Brain Connected 🧠")