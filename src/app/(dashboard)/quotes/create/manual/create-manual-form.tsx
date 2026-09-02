'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Building, User, FileText, Search, Check, ChevronLeft, ChevronRight } from 'lucide-react'
import { searchCompanies } from '@/app/actions/hubspot/searchCompanies'
import { getCompanyContacts, type CompanyContact } from '@/app/actions/hubspot/getCompanyContacts'
import { COMPANY_CONTACTS_PAGE_SIZE } from '@/lib/hubspot-constants'
import { CreateCompanyDialog, CreateContactDialog, type CreatedCompany, type CreatedContact } from './hubspot-create-dialogs'

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { getDealCurrencyOptions, getWinProbabilityOptions } from '@/app/actions/hubspot/getDealProperties'

interface CompanyResult {
  id: string
  name: string
  domain?: string
  source: 'hubspot' | 'supabase'
}

import { createHubSpotDeal } from '@/app/actions/hubspot/createDeal'

export default function CreateManualRequestForm({ restrictedToOwn = true }: { restrictedToOwn?: boolean }) {
  const router = useRouter()
  const [step, setStep] = useState(1)
  const [isSubmitting, setIsSubmitting] = useState(false)
  // In-flight guard: prevent double-click from double-creating the company/
  // contact/deal (isSubmitting alone lags a render behind the click). Shared
  // with the create-company/create-contact dialogs so a double-click there
  // is guarded the same way.
  const inFlightRef = useRef(false)

  // Form State
  const [companyName, setCompanyName] = useState('')
  const [selectedCompany, setSelectedCompany] = useState<CompanyResult | null>(null)
  const [companySearchResults, setCompanySearchResults] = useState<CompanyResult[]>([])
  const [isSearchingCompany, setIsSearchingCompany] = useState(false)
  const [companySearchError, setCompanySearchError] = useState<string | null>(null)

  const [contactName, setContactName] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [selectedContact, setSelectedContact] = useState<CompanyContact | null>(null)

  // Step 2: the selected company's own contact list — paginated and searched
  // server-side (real accounts here carry four figures of contacts, so this
  // never loads them all client-side).
  const [contacts, setContacts] = useState<CompanyContact[]>([])
  const [totalContacts, setTotalContacts] = useState<number | null>(null)
  const [nextAfter, setNextAfter] = useState<string | undefined>(undefined)
  const [cursorStack, setCursorStack] = useState<string[]>([])
  const [pageIndex, setPageIndex] = useState(1)
  const [contactSearchInput, setContactSearchInput] = useState('')
  const [contactDebouncedSearch, setContactDebouncedSearch] = useState('')
  const [contactsLoading, setContactsLoading] = useState(false)
  const [contactsError, setContactsError] = useState<string | null>(null)
  // Stale-response guard: only the response from the most recently issued
  // fetch is applied, so a slow page-1 response can't clobber a newer search
  // result, and switching company can't show the previous company's contacts.
  const requestSeqRef = useRef(0)
  const prevContactsCompanyIdRef = useRef<string | null>(null)
  // The query the list currently reflects. The debounce effect compares
  // against this so clearing the box on entry (which enterContactsStep already
  // fetched for) doesn't fire a second identical request that resets the page.
  const appliedQueryRef = useRef('')
  // Read inside the debounce timer, which closes over the render that last
  // changed the input and can otherwise fire after the rep has moved on.
  const stepRef = useRef(1)
  const selectedCompanyIdRef = useRef<string | null>(null)

  const [dealName, setDealName] = useState('')
  const [description, setDescription] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [currencyOptions, setCurrencyOptions] = useState<{label: string, value: string}[]>([])
  const [winProbability, setWinProbability] = useState('')
  const [winProbabilityOptions, setWinProbabilityOptions] = useState<{label: string, value: string}[]>([])

  useEffect(() => {
    async function fetchCurrencies() {
      const result = await getDealCurrencyOptions()
      if (result.success && result.data) {
        setCurrencyOptions(result.data)
      }
    }
    fetchCurrencies()
  }, [])

  useEffect(() => {
    async function fetchWinProbability() {
      const result = await getWinProbabilityOptions()
      if (result.success && result.data) {
        setWinProbabilityOptions(result.data)
      }
    }
    fetchWinProbability()
  }, [])

  // Keep the timer-visible refs in step with the current render.
  useEffect(() => {
    stepRef.current = step
    selectedCompanyIdRef.current = selectedCompany?.id ?? null
  }, [step, selectedCompany])

  // Stale-response guard for the company search (same pattern as the contact
  // list): the added owner-resolution hop upstream makes latency variance —
  // and therefore out-of-order responses — more likely.
  const companySearchSeqRef = useRef(0)

  // Debounced Search for Company
  useEffect(() => {
    const delayDebounceFn = setTimeout(async () => {
      if (companyName && !selectedCompany) {
        const seq = ++companySearchSeqRef.current
        setIsSearchingCompany(true)
        setCompanySearchError(null)
        try {
          const result = await searchCompanies(companyName)
          if (seq !== companySearchSeqRef.current) return
          if (result.success && result.data) {
            setCompanySearchResults(result.data)
          } else {
            // Never leave stale hits on screen next to a failure — an empty
            // dropdown reads as "not in HubSpot" and invites a duplicate.
            setCompanySearchResults([])
            setCompanySearchError(result.error ?? 'Could not search HubSpot companies.')
          }
        } catch (error: unknown) {
          if (seq !== companySearchSeqRef.current) return
          setCompanySearchResults([])
          setCompanySearchError(
            error instanceof Error ? error.message : 'Could not search HubSpot companies.'
          )
        } finally {
          // A stale request must not clear the spinner a newer one turned on.
          if (seq === companySearchSeqRef.current) setIsSearchingCompany(false)
        }
      } else {
        setCompanySearchResults([])
        setCompanySearchError(null)
      }
    }, 500)

    return () => clearTimeout(delayDebounceFn)
  }, [companyName, selectedCompany])

  // One page of the selected company's contacts, optionally filtered by a
  // search term. Guarded against out-of-order responses via requestSeqRef.
  const fetchContactsPage = useCallback(async (companyId: string, query: string, after: string | undefined) => {
    const seq = ++requestSeqRef.current
    appliedQueryRef.current = query
    setContactsLoading(true)
    setContactsError(null)
    try {
      const result = await getCompanyContacts(companyId, { query: query || undefined, after })
      if (seq !== requestSeqRef.current) return // superseded by a newer request
      if (result.success && result.data) {
        setContacts(result.data)
        setTotalContacts(typeof result.total === 'number' ? result.total : result.data.length)
        setNextAfter(result.nextAfter)
      } else {
        setContacts([])
        setTotalContacts(null)
        setNextAfter(undefined)
        setContactsError(result.error ?? "Could not load this company's contacts.")
      }
    } catch (error: unknown) {
      // The action catches its own errors, but the CALL can still reject on a
      // dropped connection or a deploy skew. Without this the loading flag
      // never clears and every recovery control stays hidden behind it.
      if (seq !== requestSeqRef.current) return
      setContacts([])
      setTotalContacts(null)
      setNextAfter(undefined)
      setContactsError(
        error instanceof Error ? error.message : "Could not load this company's contacts."
      )
    } finally {
      if (seq === requestSeqRef.current) setContactsLoading(false)
    }
  }, [])

  // Debounce the contact search box ~400ms, then fetch page 1 for the
  // current company. Deliberately keyed ONLY on contactSearchInput (not
  // step/company) — entering step 2 for a (possibly new) company is instead
  // handled explicitly by enterContactsStep below, so the two triggers can't
  // race each other with a stale query.
  useEffect(() => {
    if (step !== 2 || !selectedCompany) return
    if (contactSearchInput === appliedQueryRef.current) return
    const handle = setTimeout(() => {
      if (stepRef.current !== 2 || selectedCompanyIdRef.current !== selectedCompany.id) return
      setContactDebouncedSearch(contactSearchInput)
      setCursorStack([])
      setPageIndex(1)
      fetchContactsPage(selectedCompany.id, contactSearchInput, undefined)
    }, 400)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactSearchInput])

  // Called when the rep advances from Step 1 to Step 2 with a company
  // selected. Resets the contact list to page 1, clears any prior search,
  // and drops the selected contact only if the COMPANY actually changed
  // (revisiting Step 2 for the same company keeps the rep's selection).
  const enterContactsStep = (companyId: string) => {
    if (prevContactsCompanyIdRef.current !== companyId) {
      prevContactsCompanyIdRef.current = companyId
      setSelectedContact(null)
      setContactName('')
      setContactEmail('')
    }
    setContactSearchInput('')
    setContactDebouncedSearch('')
    setCursorStack([])
    setPageIndex(1)
    fetchContactsPage(companyId, '', undefined)
  }

  const handleClearCompany = () => {
    setSelectedCompany(null)
    setCompanyName('')
    setCompanySearchResults([])
    setCompanySearchError(null)
  }

  const handleSelectCompany = (company: CompanyResult) => {
    setSelectedCompany(company)
    setCompanyName(company.name)
    setCompanySearchResults([])
  }

  const handleCompanyCreated = (company: CreatedCompany) => {
    setSelectedCompany({ id: company.id, name: company.name, domain: company.domain, source: 'hubspot' })
    setCompanyName(company.name)
    setCompanySearchResults([])
  }

  const handleSelectContactRow = (contact: CompanyContact) => {
    setSelectedContact(contact)
    setContactName(`${contact.properties.firstname} ${contact.properties.lastname}`.trim())
    setContactEmail(contact.properties.email)
  }

  const handleContactCreated = (created: CreatedContact) => {
    const newContact: CompanyContact = {
      id: created.id,
      properties: { firstname: created.firstname, lastname: created.lastname, email: created.email },
    }
    setSelectedContact(newContact)
    setContactName(`${created.firstname} ${created.lastname}`.trim())
    setContactEmail(created.email)
    // Show the new contact at the top of the current page rather than
    // refetching: HubSpot's search index lags object creation by seconds, so a
    // refetch usually comes back WITHOUT them, and on an alphabetical page 1
    // they would rarely belong there anyway. Either way the rep would think it
    // failed and add them again.
    setContacts((prev) =>
      prev.some((c) => c.id === newContact.id) ? prev : [newContact, ...prev]
    )
  }

  const handleNextContactsPage = () => {
    if (!selectedCompany || !nextAfter) return
    const newStack = [...cursorStack, nextAfter]
    setCursorStack(newStack)
    setPageIndex((p) => p + 1)
    fetchContactsPage(selectedCompany.id, contactDebouncedSearch, nextAfter)
  }

  const handlePrevContactsPage = () => {
    if (!selectedCompany || pageIndex <= 1) return
    const newStack = cursorStack.slice(0, -1)
    const after = newStack[newStack.length - 1]
    setCursorStack(newStack)
    setPageIndex((p) => p - 1)
    fetchContactsPage(selectedCompany.id, contactDebouncedSearch, after)
  }

  const handleBackToFirstContactsPage = () => {
    if (!selectedCompany) return
    setCursorStack([])
    setPageIndex(1)
    fetchContactsPage(selectedCompany.id, contactDebouncedSearch, undefined)
  }

  const handleRetryContacts = () => {
    if (!selectedCompany) return
    const after = cursorStack[cursorStack.length - 1]
    fetchContactsPage(selectedCompany.id, contactDebouncedSearch, after)
  }

  const handleClearContactSearch = () => setContactSearchInput('')

  const totalPages =
    totalContacts === null ? null : Math.max(1, Math.ceil(totalContacts / COMPANY_CONTACTS_PAGE_SIZE))

  // Advancing a step only validates and loads — nothing is written to HubSpot
  // here any more (both creates happen in their confirmation dialogs), so this
  // needs no in-flight guard and must not claim to be "creating" anything.
  const handleNext = () => {
    if (step === 1) {
      if (!selectedCompany || !selectedCompany.id) {
        toast.error('Please select or create a company.')
        return
      }
      enterContactsStep(selectedCompany.id)
    }

    if (step === 2 && (!selectedContact || !selectedContact.id)) {
      toast.error('Please select or add a contact.')
      return
    }

    if (step < 3) setStep(step + 1)
  }

  const handleBack = () => {
    if (step > 1) setStep(step - 1)
  }

  const handleSubmit = async () => {
    // In-flight guard: prevent double-submit duplicating the HubSpot deal.
    if (inFlightRef.current) return
    if (!dealName.trim()) {
      toast.error('Please enter a deal name.')
      return
    }
    if (!winProbability) {
      toast.error('Please select a Win Probability before creating the deal.')
      return
    }
    inFlightRef.current = true
    setIsSubmitting(true)
    let createdDealId: string | null = null
    try {
      const finalCompanyId = selectedCompany?.id
      const finalContactId = selectedContact?.id

      // Guard: never create an unassociated deal — company/contact must both
      // be resolved to a real HubSpot id before we proceed.
      if (!finalCompanyId) {
        toast.error('Please select or create a company before creating the deal.')
        inFlightRef.current = false
        setIsSubmitting(false)
        return
      }
      if (!finalContactId) {
        toast.error('Please select or create a contact before creating the deal.')
        inFlightRef.current = false
        setIsSubmitting(false)
        return
      }

      const result = await createHubSpotDeal({
        dealName,
        description,
        companyId: finalCompanyId,
        contactId: finalContactId,
        currency,
        winProbability
      })

      if (result.success && result.dealId) {
        createdDealId = result.dealId
      } else {
        toast.error('Failed to create deal: ' + result.error)
        inFlightRef.current = false
        setIsSubmitting(false)
      }
    } catch (error: unknown) {
      toast.error('Failed to create deal: ' + (error instanceof Error ? error.message : String(error)))
      inFlightRef.current = false
      setIsSubmitting(false)
    }

    // Navigate OUTSIDE the try: the deal exists by this point, so a throw here
    // must never be reported as a failed deal or re-arm the button.
    // The guard is deliberately NOT released — router.push returns immediately
    // and this page stays interactive until the next route resolves, so
    // releasing it would let a second click create a second deal.
    if (createdDealId) {
      router.push(`/quotes/create/${createdDealId}`)
    }
  }

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      {/* Progress Steps */}
      <div className="flex items-center justify-between px-2 sm:px-10">
        <div className={`flex flex-col items-center ${step >= 1 ? 'text-echo-yellow' : 'text-gray-400'}`}>
          <div className={`w-8 h-8 sm:w-10 sm:h-10 rounded-full flex items-center justify-center border-2 text-sm sm:text-base font-bold mb-2 ${step >= 1 ? 'border-echo-yellow bg-black text-echo-yellow' : 'border-gray-300 bg-white text-gray-400'}`}>1</div>
          <span className="text-xs font-medium uppercase tracking-wider">Company</span>
        </div>
        <div className={`flex-1 h-0.5 mx-2 sm:mx-4 ${step >= 2 ? 'bg-echo-yellow' : 'bg-gray-200'}`}></div>
        <div className={`flex flex-col items-center ${step >= 2 ? 'text-echo-yellow' : 'text-gray-400'}`}>
          <div className={`w-8 h-8 sm:w-10 sm:h-10 rounded-full flex items-center justify-center border-2 text-sm sm:text-base font-bold mb-2 ${step >= 2 ? 'border-echo-yellow bg-black text-echo-yellow' : 'border-gray-300 bg-white text-gray-400'}`}>2</div>
          <span className="text-xs font-medium uppercase tracking-wider">Contact</span>
        </div>
        <div className={`flex-1 h-0.5 mx-2 sm:mx-4 ${step >= 3 ? 'bg-echo-yellow' : 'bg-gray-200'}`}></div>
        <div className={`flex flex-col items-center ${step >= 3 ? 'text-echo-yellow' : 'text-gray-400'}`}>
          <div className={`w-8 h-8 sm:w-10 sm:h-10 rounded-full flex items-center justify-center border-2 text-sm sm:text-base font-bold mb-2 ${step >= 3 ? 'border-echo-yellow bg-black text-echo-yellow' : 'border-gray-300 bg-white text-gray-400'}`}>3</div>
          <span className="text-xs font-medium uppercase tracking-wider">Deal Details</span>
        </div>
      </div>

      <Card className="p-8 max-sm:p-4 bg-white border-gray-200 shadow-sm">
        {/* Step 1: Company Information */}
        {step === 1 && (
          <div className="space-y-6">
            <div className="flex items-center gap-3 mb-6 border-b border-gray-100 pb-4">
              <Building className="w-6 h-6 text-gray-400" />
              <h2 className="text-xl font-bold text-gray-900">Company Information</h2>
            </div>

            <div className="space-y-4">
              <div className="space-y-2 relative">
                <Label className="text-gray-700">Company Name *</Label>
                <div className="relative">
                  <Search className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                  <Input
                    placeholder={restrictedToOwn ? 'Search your companies…' : 'Search all companies…'}
                    className="pl-10 bg-white border-gray-300 text-gray-900 focus:ring-echo-yellow"
                    value={companyName}
                    onChange={(e) => {
                      setCompanyName(e.target.value)
                      setSelectedCompany(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setCompanySearchResults([])
                    }}
                  />
                  {selectedCompany && (
                    <div className="absolute right-3 top-3 text-green-600">
                      <Check className="h-4 w-4" />
                    </div>
                  )}
                  {isSearchingCompany && !selectedCompany && (
                    <span className="absolute right-3 top-3 text-xs text-gray-400">Searching…</span>
                  )}
                </div>

                {/* Company Search Results Dropdown */}
                {companySearchResults.length > 0 && !selectedCompany && (
                  <div className="absolute z-10 w-full bg-white border border-gray-200 rounded-md shadow-lg mt-1 max-h-60 overflow-auto">
                    <div className="flex items-center justify-between px-4 py-2 border-b border-gray-100 bg-gray-50 sticky top-0">
                      <span className="text-xs text-gray-500">
                        {companySearchResults.length} match{companySearchResults.length === 1 ? '' : 'es'}
                      </span>
                      <button
                        type="button"
                        onClick={() => setCompanySearchResults([])}
                        className="text-xs font-medium text-gray-600 hover:text-gray-900"
                      >
                        Dismiss
                      </button>
                    </div>
                    {companySearchResults.map((company) => (
                      <button
                        type="button"
                        key={company.id}
                        className="w-full text-left px-4 py-3 hover:bg-gray-50 cursor-pointer border-b border-gray-50 last:border-0"
                        onClick={() => handleSelectCompany(company)}
                      >
                        <p className="font-medium text-gray-900 max-sm:truncate">{company.name}</p>
                        <div className="flex items-center gap-2 mt-1">
                          <span className={`text-xs px-2 py-0.5 rounded-full ${company.source === 'supabase' ? 'bg-blue-100 text-blue-800' : 'bg-orange-100 text-orange-800'}`}>
                            {company.source === 'supabase' ? 'Account Registry' : 'HubSpot'}
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}

                {companySearchError ? (
                  <p className="text-xs text-red-600">
                    {companySearchError} Search again before creating — this company may already exist.
                  </p>
                ) : (
                  <p className="text-xs text-gray-500">
                    {restrictedToOwn
                      ? 'Searches the HubSpot companies assigned to you, or create a new one below.'
                      : 'Search existing HubSpot companies, or create a new one below.'}
                  </p>
                )}
              </div>

              {selectedCompany ? (
                <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 flex items-center justify-between gap-3">
                  <span className="min-w-0 break-words">
                    Selected: <span className="font-semibold">{companyName}</span>
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleClearCompany}
                    className="border-green-300 text-green-800 hover:bg-green-100 shrink-0"
                  >
                    Change
                  </Button>
                </div>
              ) : (
                /* Only offered while nothing is selected. Left permanently
                   available, a rep fixing a mistyped domain would click it
                   again and mint a duplicate — createHubSpotCompany's dedup
                   reads a different domain as a different business. */
                <CreateCompanyDialog initialName={companyName} inFlightRef={inFlightRef} onCreated={handleCompanyCreated} restrictedToOwn={restrictedToOwn} />
              )}
            </div>
          </div>
        )}

        {/* Step 2: Contact Information */}
        {step === 2 && (
          <div className="space-y-6">
            <div className="flex items-center gap-3 mb-6 border-b border-gray-100 pb-4">
              <User className="w-6 h-6 text-gray-400" />
              <h2 className="text-xl font-bold text-gray-900">Contact Information</h2>
            </div>

            {!selectedCompany ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-6 text-center text-sm text-amber-800">
                <p>Select a company in Step 1 before choosing a contact.</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleBack}
                disabled={isSubmitting}
                  className="mt-3 border-amber-300 text-amber-800 hover:bg-amber-100"
                >
                  Back to Company
                </Button>
              </div>
            ) : (
              <div className="space-y-4">
                {selectedContact && (
                  <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 break-words">
                    Selected: <span className="font-semibold">{contactName}</span>
                    {contactEmail ? ` — ${contactEmail}` : ''}
                  </div>
                )}

                <div className="space-y-2">
                  <Label className="text-gray-700">Search Contacts</Label>
                  <div className="relative">
                    <Search className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                    <Input
                      placeholder={`Search all contacts at ${selectedCompany.name}…`}
                      className="pl-10 bg-white border-gray-300 text-gray-900 focus:ring-echo-yellow"
                      value={contactSearchInput}
                      onChange={(e) => setContactSearchInput(e.target.value)}
                    />
                  </div>
                  <p className="text-xs text-gray-500">
                    Searches all of {selectedCompany.name}&apos;s contacts in HubSpot — not just the page below.
                    Someone missing here can still be added with the button underneath; an existing
                    email is linked rather than duplicated.
                  </p>
                </div>

                <div className="border border-gray-200 rounded-md divide-y divide-gray-100 overflow-hidden">
                  {contactsLoading ? (
                    <div className="p-3 space-y-2">
                      {Array.from({ length: 4 }).map((_, i) => (
                        <Skeleton key={i} className="h-14 w-full" />
                      ))}
                    </div>
                  ) : contactsError ? (
                    <div className="px-4 py-6 text-center text-sm space-y-3">
                      <p className="text-red-600">{contactsError}</p>
                      <div className="flex items-center justify-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleRetryContacts}
                          className="border-gray-300 text-gray-700 hover:bg-gray-50"
                        >
                          Retry
                        </Button>
                        {pageIndex > 1 && (
                          /* Retry re-sends the cursor that just failed, so a
                             bad cursor deep in the list would loop forever. */
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={handleBackToFirstContactsPage}
                            className="border-gray-300 text-gray-700 hover:bg-gray-50"
                          >
                            Back to first page
                          </Button>
                        )}
                      </div>
                    </div>
                  ) : contacts.length === 0 ? (
                    <div className="px-4 py-6 text-center text-sm text-gray-500 space-y-3">
                      {contactDebouncedSearch ? (
                        <>
                          <p>
                            No contacts at {selectedCompany.name} match &quot;{contactDebouncedSearch}&quot;.
                          </p>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={handleClearContactSearch}
                            className="border-gray-300 text-gray-700 hover:bg-gray-50"
                          >
                            Clear search
                          </Button>
                        </>
                      ) : (
                        <p>No contacts are linked to {selectedCompany.name} yet in HubSpot.</p>
                      )}
                    </div>
                  ) : (
                    contacts.map((contact) => {
                      const isSelected = selectedContact?.id === contact.id
                      const fullName =
                        `${contact.properties.firstname} ${contact.properties.lastname}`.trim() ||
                        contact.properties.email
                      return (
                        <button
                          key={contact.id}
                          type="button"
                          onClick={() => handleSelectContactRow(contact)}
                          className={`w-full min-h-11 text-left px-4 py-3 flex items-start justify-between gap-3 transition-colors ${
                            isSelected ? 'bg-echo-yellow/10 ring-1 ring-inset ring-echo-yellow' : 'hover:bg-gray-50'
                          }`}
                        >
                          <div className="min-w-0">
                            <p className="font-medium text-gray-900 max-sm:truncate">{fullName}</p>
                            <p className="text-sm text-gray-500 max-sm:truncate">{contact.properties.email}</p>
                            {contact.properties.jobtitle && (
                              <p className="text-xs text-gray-400 mt-0.5 max-sm:truncate">{contact.properties.jobtitle}</p>
                            )}
                          </div>
                          {isSelected && <Check className="h-4 w-4 text-echo-yellow shrink-0 mt-1" />}
                        </button>
                      )
                    })
                  )}
                </div>

                {!contactsLoading && !contactsError && (
                  <div className="flex items-center justify-between gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handlePrevContactsPage}
                      disabled={pageIndex <= 1}
                      className="shrink-0 py-3.5 sm:py-2 border-gray-300 text-gray-700 hover:bg-gray-50"
                    >
                      <ChevronLeft className="w-4 h-4 mr-1" />
                      Prev
                    </Button>
                    <span className="min-w-0 text-xs text-gray-500 text-center px-2">
                      Page {pageIndex}
                      {totalPages !== null && totalPages > 1 ? ` of ${totalPages.toLocaleString()}` : ''}
                      {totalContacts !== null && (
                        <>
                          {' · '}
                          {totalContacts.toLocaleString()}{' '}
                          {contactDebouncedSearch
                            ? `${totalContacts === 1 ? 'match' : 'matches'} for "${contactDebouncedSearch}"`
                            : `${totalContacts === 1 ? 'contact' : 'contacts'} at ${selectedCompany.name}`}
                        </>
                      )}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleNextContactsPage}
                      disabled={!nextAfter}
                      className="shrink-0 py-3.5 sm:py-2 border-gray-300 text-gray-700 hover:bg-gray-50"
                    >
                      Next
                      <ChevronRight className="w-4 h-4 ml-1" />
                    </Button>
                  </div>
                )}

                <CreateContactDialog
                  companyId={selectedCompany.id}
                  companyName={selectedCompany.name}
                  inFlightRef={inFlightRef}
                  onCreated={handleContactCreated}
                />
              </div>
            )}
          </div>
        )}

        {/* Step 3: Deal Details */}
        {step === 3 && (
          <div className="space-y-6">
            <div className="flex items-center gap-3 mb-6 border-b border-gray-100 pb-4">
              <FileText className="w-6 h-6 text-gray-400" />
              <h2 className="text-xl font-bold text-gray-900">Deal Details</h2>
            </div>

            <div className="space-y-4">
              <div className="space-y-2">
                <Label className="text-gray-700">Deal Name *</Label>
                <Input
                  placeholder="e.g. New Project Quote"
                  className="bg-white border-gray-300 text-gray-900 focus:ring-echo-yellow"
                  value={dealName}
                  onChange={(e) => setDealName(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label className="text-gray-700">Currency</Label>
                <Select value={currency} onValueChange={setCurrency}>
                  <SelectTrigger className="bg-white border-gray-300 text-gray-900 focus:ring-echo-yellow">
                    <SelectValue placeholder="Select Currency" />
                  </SelectTrigger>
                  <SelectContent className="bg-white border-gray-200 text-gray-900">
                    {currencyOptions.length > 0 ? (
                      currencyOptions.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value} className="hover:bg-gray-100 focus:bg-gray-100 cursor-pointer">
                          {opt.label}
                        </SelectItem>
                      ))
                    ) : (
                      <SelectItem value="USD">USD - US Dollar</SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label className="text-gray-700">Win Probability *</Label>
                <Select value={winProbability} onValueChange={setWinProbability}>
                  <SelectTrigger className="bg-white border-gray-300 text-gray-900 focus:ring-echo-yellow">
                    <SelectValue placeholder="Select win probability..." />
                  </SelectTrigger>
                  <SelectContent className="bg-white border-gray-200 text-gray-900">
                    {winProbabilityOptions.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value} className="hover:bg-gray-100 focus:bg-gray-100 cursor-pointer">
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-gray-500">Required for all non-tender deals.</p>
              </div>

              <div className="space-y-2">
                <Label className="text-gray-700">Description</Label>
                <textarea
                  className="flex min-h-[100px] w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-base sm:text-sm text-gray-900 ring-offset-background placeholder:text-gray-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-echo-yellow focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  placeholder="Enter details about the deal..."
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
            </div>
          </div>
        )}

        {/* Footer Actions */}
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between mt-8 pt-6 border-t border-gray-100">
          {step > 1 ? (
            <Button variant="outline" onClick={handleBack} className="w-full sm:w-auto py-3 sm:py-2.5 text-gray-600 border-gray-300 hover:bg-gray-50">
              Back
            </Button>
          ) : (
            <div></div> // Spacer
          )}

          {step < 3 ? (
            <Button onClick={handleNext} disabled={isSubmitting} className="w-full sm:w-auto py-3 sm:py-2.5 bg-black text-white hover:bg-gray-800 disabled:opacity-60">
              Next Step
            </Button>
          ) : (
            <Button onClick={handleSubmit} disabled={isSubmitting} className="w-full sm:w-auto py-3 sm:py-2.5 bg-echo-yellow text-black hover:bg-echo-yellow/90 font-bold disabled:opacity-60">
              {isSubmitting ? 'Creating deal…' : 'Create deal in HubSpot'}
            </Button>
          )}
        </div>
      </Card>
    </div>
  )
}
