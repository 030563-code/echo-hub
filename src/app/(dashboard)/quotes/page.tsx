import { redirect } from 'next/navigation'

// The Quotes index → the incoming requests queue (the working entry point).
export default function QuotesIndex() {
  redirect('/quotes/requests')
}
