import { redirect } from 'next/navigation'

/** Deal detail moved to /quotes/deals/[id]. See ../page.tsx for why this is a
 *  redirect() stub rather than a next.config.ts rule. */
export default async function LegacyQuoteRequestDetailRedirect(props: {
  params: Promise<{ id: string }>
}) {
  const { id } = await props.params
  redirect(`/quotes/deals/${id}`)
}
