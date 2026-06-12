'use client'

import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Building, User, FileText, Search, Check, Plus } from 'lucide-react'
import { searchCompanies } from '@/app/actions/hubspot/searchCompanies'
import { searchHubSpotContact, getContactAssociations } from '@/app/actions/hubspot/searchContact'

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { getDealCurrencyOptions, getWinProbabilityOptions } from '@/app/actions/hubspot/getDealProperties'

interface CompanyResult {
  id: string
  name: string
  domain?: string
  source: 'hubspot' | 'supabase'
}

interface ContactResult {
  id: string
  properties: {
    firstname: string
    lastname: string
    email: string
  }
}

import { createHubSpotContact } from '@/app/actions/hubspot/createContact'
import { createHubSpotDeal } from '@/app/actions/hubspot/createDeal'
import { createHubSpotCompany } from '@/app/actions/hubspot/createCompany'

export default function CreateManualRequestForm() {
  const router = useRouter()
  const [step, setStep] = useState(1)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Form State
  const [companyName, setCompanyName] = useState('')
  const [companyDomain, setCompanyDomain] = useState('')
  const [selectedCompany, setSelectedCompany] = useState<CompanyResult | null>(null)
  const [companySearchResults, setCompanySearchResults] = useState<CompanyResult[]>([])
  const [isSearchingCompany, setIsSearchingCompany] = useState(false)

  const [contactName, setContactName] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [selectedContact, setSelectedContact] = useState<ContactResult | null>(null)
  const [contactSearchResults, setContactSearchResults] = useState<ContactResult[]>([])
  const [isSearchingContact, setIsSearchingContact] = useState(false)

  const [dealName, setDealName] = useState('')
  const [dealAmount, setDealAmount] = useState('')
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

  // Debounced Search for Company
  useEffect(() => {
    const delayDebounceFn = setTimeout(async () => {
      if (companyName && !selectedCompany) {
        setIsSearchingCompany(true)
        const result = await searchCompanies(companyName)
        if (result.success && result.data) {
          setCompanySearchResults(result.data)
        }
        setIsSearchingCompany(false)
      } else {
        setCompanySearchResults([])
      }
    }, 500)

    return () => clearTimeout(delayDebounceFn)
  }, [companyName, selectedCompany])

  // Debounced Search for Contact
  useEffect(() => {
    const delayDebounceFn = setTimeout(async () => {
      if ((contactName || contactEmail) && !selectedContact) {
        setIsSearchingContact(true)
        const query = contactEmail || contactName
        if (query.length > 2) {
            // If a company is selected, try to extract domain from it (if available)
            // Note: We don't have the domain in the selectedCompany object yet, but we could fetch it or infer it.
            // For now, we'll just pass the query.
            // Ideally, we should pass the company domain if we have it.
            
            let domain = undefined
            if (selectedCompany && selectedCompany.source === 'hubspot' && selectedCompany.domain) {
               domain = selectedCompany.domain
            }
            
            if (!domain && contactEmail.includes('@')) {
                domain = contactEmail.split('@')[1]
            }

            const result = await searchHubSpotContact(query, domain)
            if (result.success && result.data) {
            setContactSearchResults(result.data)
            }
        }
        setIsSearchingContact(false)
      } else {
        setContactSearchResults([])
      }
    }, 500)

    return () => clearTimeout(delayDebounceFn)
  }, [contactName, contactEmail, selectedContact, selectedCompany])

  const handleSelectCompany = (company: CompanyResult) => {
    setSelectedCompany(company)
    setCompanyName(company.name)
    setCompanySearchResults([])
  }

  const handleSelectContact = async (contact: ContactResult) => {
    setSelectedContact(contact)
    setContactName(`${contact.properties.firstname} ${contact.properties.lastname}`)
    setContactEmail(contact.properties.email)
    setContactSearchResults([])

    // Auto-suggest company if not selected
    if (!selectedCompany) {
        const assocResult = await getContactAssociations(contact.id)
        if (assocResult.success && assocResult.data.associations?.companies?.results?.length > 0) {
            // A company association exists in HubSpot. Ideally we would fetch the
            // company name here, but for now we just know an associated company ID exists
            // and leave it for the user to confirm in the company step.
        }
    }
  }

  const handleNext = async () => {
    setIsSubmitting(true)
    try {
      // Step 1 Validation & Creation
      if (step === 1) {
        if (!selectedCompany && !companyName) {
          toast.error('Please select or enter a company name.')
          return
        }

        // If creating a new company, do it now
        if (selectedCompany?.id === 'new') {
          if (!companyDomain) {
            toast.error('Please enter a company domain.')
            return
          }

          const companyResult = await createHubSpotCompany({
            name: companyName,
            domain: companyDomain
          })

          if (companyResult.success && companyResult.companyId) {
            // Update selected company with the new real ID
            setSelectedCompany({
              id: companyResult.companyId,
              name: companyName,
              domain: companyDomain,
              source: 'hubspot'
            })
          } else {
            toast.error('Failed to create company: ' + companyResult.error)
            return // Stop here
          }
        }
      }

      // Step 2 Validation & Creation
      if (step === 2) {
        if (!selectedContact && !contactName) {
          toast.error('Please select or enter a contact name.')
          return
        }

        // If creating a new contact, do it now
        if (selectedContact?.id === 'new') {
          if (!contactEmail) {
            toast.error('Please enter an email address.')
            return
          }

          const nameParts = contactName.split(' ')
          const firstname = nameParts[0]
          const lastname = nameParts.slice(1).join(' ') || ''

          const contactResult = await createHubSpotContact({
            firstname,
            lastname,
            email: contactEmail,
            companyId: selectedCompany?.id // Associate with the company (which is now a real ID)
          })

          if (contactResult.success && contactResult.contactId) {
            // Update selected contact with the new real ID
            setSelectedContact({
              id: contactResult.contactId,
              properties: {
                firstname,
                lastname,
                email: contactEmail
              }
            })
          } else {
            toast.error('Failed to create contact: ' + contactResult.error)
            return // Stop here
          }
        }
      }

      if (step < 3) setStep(step + 1)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleBack = () => {
    if (step > 1) setStep(step - 1)
  }

  const handleSubmit = async () => {
    if (!winProbability) {
      toast.error('Please select a Win Probability before creating the deal.')
      return
    }
    const finalCompanyId = selectedCompany?.id
    const finalContactId = selectedContact?.id

    // Guard: never create an unassociated deal. The company/contact must be
    // resolved to a real HubSpot id (not missing, empty, or the 'new' sentinel)
    // before we proceed.
    if (!finalCompanyId || finalCompanyId === 'new') {
      toast.error('Please select or create a company before creating the deal.')
      return
    }
    if (!finalContactId || finalContactId === 'new') {
      toast.error('Please select or create a contact before creating the deal.')
      return
    }

    setIsSubmitting(true)
    try {
      // 1. Company is already created in Step 1 if it was new
      // 2. Contact is already created in Step 2 if it was new
      // We just use the IDs which should be real IDs now

      // 3. Create Deal in HubSpot
      const result = await createHubSpotDeal({
        dealName,
        description,
        companyId: finalCompanyId,
        contactId: finalContactId,
        currency,
        winProbability
      })

      if (result.success && result.dealId) {
        // 4. Redirect to Create Quote Page for this new deal
        router.push(`/quotes/create/${result.dealId}`)
      } else {
        toast.error('Failed to create deal: ' + result.error)
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      {/* Progress Steps */}
      <div className="flex items-center justify-between px-10">
        <div className={`flex flex-col items-center ${step >= 1 ? 'text-echo-yellow' : 'text-gray-400'}`}>
          <div className={`w-10 h-10 rounded-full flex items-center justify-center border-2 font-bold mb-2 ${step >= 1 ? 'border-echo-yellow bg-black text-echo-yellow' : 'border-gray-300 bg-white text-gray-400'}`}>1</div>
          <span className="text-xs font-medium uppercase tracking-wider">Company</span>
        </div>
        <div className={`flex-1 h-0.5 mx-4 ${step >= 2 ? 'bg-echo-yellow' : 'bg-gray-200'}`}></div>
        <div className={`flex flex-col items-center ${step >= 2 ? 'text-echo-yellow' : 'text-gray-400'}`}>
          <div className={`w-10 h-10 rounded-full flex items-center justify-center border-2 font-bold mb-2 ${step >= 2 ? 'border-echo-yellow bg-black text-echo-yellow' : 'border-gray-300 bg-white text-gray-400'}`}>2</div>
          <span className="text-xs font-medium uppercase tracking-wider">Contact</span>
        </div>
        <div className={`flex-1 h-0.5 mx-4 ${step >= 3 ? 'bg-echo-yellow' : 'bg-gray-200'}`}></div>
        <div className={`flex flex-col items-center ${step >= 3 ? 'text-echo-yellow' : 'text-gray-400'}`}>
          <div className={`w-10 h-10 rounded-full flex items-center justify-center border-2 font-bold mb-2 ${step >= 3 ? 'border-echo-yellow bg-black text-echo-yellow' : 'border-gray-300 bg-white text-gray-400'}`}>3</div>
          <span className="text-xs font-medium uppercase tracking-wider">Deal Details</span>
        </div>
      </div>

      <Card className="p-8 bg-white border-gray-200 shadow-sm">
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
                    placeholder="Search or enter company name..." 
                    className="pl-10 bg-white border-gray-300 text-gray-900 focus:ring-echo-yellow"
                    value={companyName}
                    onChange={(e) => {
                      setCompanyName(e.target.value)
                      setSelectedCompany(null)
                    }}
                  />
                  {selectedCompany && selectedCompany.id !== 'new' && (
                    <div className="absolute right-3 top-3 text-green-600">
                      <Check className="h-4 w-4" />
                    </div>
                  )}
                  {selectedCompany && selectedCompany.id === 'new' && (
                    <div className="absolute right-3 top-3 text-echo-yellow">
                      <Plus className="h-4 w-4" />
                    </div>
                  )}
                </div>
                
                {/* Company Search Results Dropdown */}
                {companySearchResults.length > 0 && !selectedCompany && (
                  <div className="absolute z-10 w-full bg-white border border-gray-200 rounded-md shadow-lg mt-1 max-h-60 overflow-auto">
                    {companySearchResults.map((company) => (
                      <div 
                        key={company.id}
                        className="px-4 py-3 hover:bg-gray-50 cursor-pointer border-b border-gray-50 last:border-0"
                        onClick={() => handleSelectCompany(company)}
                      >
                        <p className="font-medium text-gray-900">{company.name}</p>
                        <div className="flex items-center gap-2 mt-1">
                          <span className={`text-xs px-2 py-0.5 rounded-full ${company.source === 'supabase' ? 'bg-blue-100 text-blue-800' : 'bg-orange-100 text-orange-800'}`}>
                            {company.source === 'supabase' ? 'Account Registry' : 'HubSpot'}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Create New Company Option */}
                {companyName.length > 2 && companySearchResults.length === 0 && !selectedCompany && !isSearchingCompany && (
                  <div className="absolute z-10 w-full bg-white border border-gray-200 rounded-md shadow-lg mt-1 p-2">
                    <div 
                      className="px-4 py-3 hover:bg-gray-50 cursor-pointer rounded-md flex items-center gap-2 text-echo-yellow"
                      onClick={() => {
                        setSelectedCompany({ id: 'new', name: companyName, source: 'hubspot' }) // Mark as new
                        setCompanySearchResults([])
                      }}
                    >
                      <Plus className="w-4 h-4" />
                      <span className="font-medium">Create new company &quot;{companyName}&quot;</span>
                    </div>
                  </div>
                )}
                
                <p className="text-xs text-gray-500">Search existing HubSpot companies or create a new one.</p>
              </div>

              {/* Company Domain Input (Only if creating new company) */}
              {selectedCompany?.id === 'new' && (
                <div className="space-y-2">
                  <Label className="text-gray-700">Company Domain *</Label>
                  <Input 
                    placeholder="example.com" 
                    className="bg-white border-gray-300 text-gray-900 focus:ring-echo-yellow"
                    value={companyDomain}
                    onChange={(e) => setCompanyDomain(e.target.value)}
                    required
                  />
                  <p className="text-xs text-gray-500">Required for deduplication in HubSpot.</p>
                </div>
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
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <Label className="text-gray-700">Email Address *</Label>
                <Input 
                  type="email"
                  placeholder="john@example.com" 
                  className="bg-white border-gray-300 text-gray-900 focus:ring-echo-yellow"
                  value={contactEmail}
                  onChange={(e) => {
                    setContactEmail(e.target.value)
                    setSelectedContact(null)
                  }}
                />
              </div>

              <div className="space-y-2 relative">
                <Label className="text-gray-700">Contact Name *</Label>
                <Input 
                  placeholder="John Doe" 
                  className="bg-white border-gray-300 text-gray-900 focus:ring-echo-yellow"
                  value={contactName}
                  onChange={(e) => {
                    setContactName(e.target.value)
                    setSelectedContact(null)
                  }}
                />
                
                {/* Create New Contact Option */}
                {contactName.length > 2 && contactSearchResults.length === 0 && !selectedContact && !isSearchingContact && (
                  <div className="absolute z-10 w-full bg-white border border-gray-200 rounded-md shadow-lg mt-1 p-2">
                    <div 
                      className="px-4 py-3 hover:bg-gray-50 cursor-pointer rounded-md flex items-center gap-2 text-echo-yellow"
                      onClick={() => {
                        // We'll create the contact immediately or mark it for creation
                        // For better UX, let's mark it as 'new' and create it on submission or right now?
                        // Let's create it right now to get an ID, or just mark it.
                        // Marking it is safer if they abandon the form.
                        // But we need an ID for the deal creation.
                        // Let's mark it as new and handle creation in handleSubmit.
                        setSelectedContact({ id: 'new', properties: { firstname: contactName.split(' ')[0], lastname: contactName.split(' ').slice(1).join(' '), email: contactEmail } })
                        setContactSearchResults([])
                      }}
                    >
                      <Plus className="w-4 h-4" />
                      <span className="font-medium">Create new contact &quot;{contactName}&quot;</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
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
                  className="flex min-h-[100px] w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 ring-offset-background placeholder:text-gray-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-echo-yellow focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  placeholder="Enter details about the request..."
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
            </div>
          </div>
        )}

        {/* Footer Actions */}
        <div className="flex justify-between mt-8 pt-6 border-t border-gray-100">
          {step > 1 ? (
            <Button variant="outline" onClick={handleBack} className="text-gray-600 border-gray-300 hover:bg-gray-50">
              Back
            </Button>
          ) : (
            <div></div> // Spacer
          )}

          {step < 3 ? (
            <Button onClick={handleNext} disabled={isSubmitting} className="bg-black text-white hover:bg-gray-800 disabled:opacity-60">
              {isSubmitting ? 'Creating...' : 'Next Step'}
            </Button>
          ) : (
            <Button onClick={handleSubmit} disabled={isSubmitting} className="bg-echo-yellow text-black hover:bg-echo-yellow/90 font-bold disabled:opacity-60">
              {isSubmitting ? 'Creating...' : 'Create Request'}
            </Button>
          )}
        </div>
      </Card>
    </div>
  )
}
