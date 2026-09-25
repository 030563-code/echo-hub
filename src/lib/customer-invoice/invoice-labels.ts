/**
 * Every word the customer invoice PDF prints that is ours rather than the
 * customer's data, in English, French and Spanish.
 *
 * Labels only. Amounts and their number format, legal names, the tax wording
 * (the tax line's name comes from the organisation's profile, TVA for France,
 * and is the same in every language) and every stored value print exactly as
 * they are. So does the payment terms phrase, which is snapshotted onto the
 * invoice from Xero in English: it is a value, not a label. How dates are
 * written is decided in document-language.ts.
 *
 * The English column is the document as it printed before this existed, word
 * for word, and the golden hashes in invoice-document-language.test.ts hold it
 * there: a USA invoice's PDF must not change by a byte.
 *
 * InvoiceLabels has every key required, so a language cannot quietly lose one:
 * the compiler refuses the table before the test does. Strings with {name}
 * placeholders are filled by fillLabel, never by string concatenation, because
 * word order differs between the languages.
 *
 * Length matters as much as wording. French and Spanish run longer than
 * English, and several labels sit in a fixed space: the draft warning passes
 * under France's letterhead, and the payment labels have 30 mm before their
 * values start. The first French draft warning ran into the TVA line. The test
 * measures each of these in the PDF's own font, so keep a new wording short
 * enough to pass it.
 */

import type { DocumentLanguage } from './document-language'

export interface InvoiceLabels {
  // The title, and the warning a preview carries
  title: string
  draftTitle: string
  draftWarning: string

  // The panel under the title
  invoiceNumber: string
  draftReference: string
  issued: string
  due: string
  customerPo: string
  despatchedFrom: string
  /** An order that left more than one depot. {count} and {places}. */
  shipments: string
  /** Between the depots' places in that line. */
  placesJoin: string

  // The two address blocks
  billTo: string
  shipTo: string
  collection: string
  collectedByCustomer: string
  /** The foot of the delivery block. {name}. */
  requestedBy: string
  /** Bill to, when neither Xero nor the registry names the company. */
  customer: string

  // The lines table
  colDescription: string
  colQuantity: string
  colUnitPrice: string
  colNet: string
  colRate: string
  colTax: string
  colLineTotal: string
  /** The rate cell of a line with no rate at all. */
  noRate: string
  /** Under each depot's group on a split order. {place}. */
  shipmentSubtotal: string

  // The totals
  taxableNet: string
  freightTaxable: string
  freightNotTaxable: string
  totalDue: string

  // How to pay
  howToPay: string
  accountName: string
  bank: string
  bankAddress: string
  routingNumber: string
  accountNumber: string
  iban: string
  bic: string
  paymentReference: string

  /** Where TaxJar placed the sale, under the totals (USA). {place}. */
  taxJurisdiction: string
}

const en: InvoiceLabels = {
  title: 'Invoice',
  draftTitle: 'Draft invoice',
  draftWarning: 'NOT AN INVOICE. Preview only, no number allocated and nothing filed.',

  invoiceNumber: 'INVOICE',
  draftReference: 'DRAFT REFERENCE',
  issued: 'ISSUED',
  due: 'DUE',
  customerPo: 'CUSTOMER PO',
  despatchedFrom: 'DESPATCHED FROM',
  shipments: '{count} shipments, {places}',
  placesJoin: ' and ',

  billTo: 'BILL TO',
  shipTo: 'SHIP TO',
  collection: 'COLLECTION',
  collectedByCustomer: 'Collected by the customer',
  requestedBy: 'Requested by: {name}',
  customer: 'Customer',

  colDescription: 'DESCRIPTION',
  colQuantity: 'QTY',
  colUnitPrice: 'UNIT',
  colNet: 'NET',
  colRate: 'RATE',
  colTax: 'TAX',
  colLineTotal: 'LINE TOTAL',
  noRate: 'exempt',
  shipmentSubtotal: 'Subtotal, {place}',

  taxableNet: 'Taxable net',
  freightTaxable: 'Freight (taxable)',
  freightNotTaxable: 'Freight (not taxable)',
  totalDue: 'Total due',

  howToPay: 'How to pay',
  accountName: 'Account Name',
  bank: 'Bank',
  bankAddress: 'Address',
  routingNumber: 'Routing Number',
  accountNumber: 'Account No',
  iban: 'IBAN',
  bic: 'BIC',
  paymentReference: 'Reference',

  taxJurisdiction: 'Tax jurisdiction {place}',
}

/**
 * French, as a French accounts department reads an invoice: Désignation, PU HT,
 * Montant HT, Total TTC, Net HT, Total à payer. "HT" and "TTC" are how French
 * says before and after tax; the tax itself is still named by the profile.
 */
const fr: InvoiceLabels = {
  title: 'Facture',
  draftTitle: 'Projet de facture',
  draftWarning: "CECI N'EST PAS UNE FACTURE. Aperçu sans numéro, rien n'est enregistré.",

  invoiceNumber: 'FACTURE N°',
  draftReference: 'RÉFÉRENCE PROVISOIRE',
  issued: "DATE D'ÉMISSION",
  due: 'ÉCHÉANCE',
  customerPo: 'N° DE COMMANDE CLIENT',
  despatchedFrom: 'EXPÉDIÉ DEPUIS',
  shipments: '{count} expéditions, {places}',
  placesJoin: ' et ',

  billTo: 'ADRESSE DE FACTURATION',
  shipTo: 'ADRESSE DE LIVRAISON',
  collection: 'ENLÈVEMENT',
  collectedByCustomer: 'Enlèvement par le client',
  requestedBy: 'Demandé par : {name}',
  customer: 'Client',

  colDescription: 'DÉSIGNATION',
  colQuantity: 'QTÉ',
  colUnitPrice: 'PU HT',
  colNet: 'MONTANT HT',
  colRate: 'TAUX',
  colTax: 'TAXE',
  colLineTotal: 'TOTAL TTC',
  // Not "exonéré". On a French invoice that word claims a legal exemption,
  // which has to cite its article, and the only line that reaches this cell on
  // an invoice Xero priced is one priced at zero: no tax, nothing exempted.
  noRate: 'non taxé',
  shipmentSubtotal: 'Sous-total, {place}',

  taxableNet: 'Net HT',
  freightTaxable: 'Frais de transport (imposables)',
  freightNotTaxable: 'Frais de transport (non imposables)',
  totalDue: 'Total à payer',

  howToPay: 'Modalités de paiement',
  // The words Claire's customers already read in the payment block of her
  // HubSpot invoices.
  accountName: 'Titulaire du compte',
  bank: 'Banque',
  bankAddress: 'Adresse',
  routingNumber: 'N° de routage',
  accountNumber: 'N° de compte',
  iban: 'IBAN',
  bic: 'BIC',
  paymentReference: 'Référence',

  taxJurisdiction: 'Juridiction fiscale {place}',
}

/**
 * Spanish as it is written in Spain, where Claire's Spanish customers are:
 * Importe, Tipo for the rate, Total a pagar, and Concepto for what the payer
 * types into the transfer.
 */
const es: InvoiceLabels = {
  title: 'Factura',
  draftTitle: 'Borrador de factura',
  draftWarning: 'NO ES UNA FACTURA. Solo vista previa, sin número asignado ni nada registrado.',

  invoiceNumber: 'FACTURA N.º',
  draftReference: 'REFERENCIA PROVISIONAL',
  issued: 'FECHA DE EMISIÓN',
  due: 'VENCIMIENTO',
  customerPo: 'N.º DE PEDIDO DEL CLIENTE',
  despatchedFrom: 'ENVIADO DESDE',
  shipments: '{count} envíos, {places}',
  placesJoin: ' y ',

  billTo: 'DIRECCIÓN DE FACTURACIÓN',
  shipTo: 'DIRECCIÓN DE ENTREGA',
  collection: 'RECOGIDA',
  collectedByCustomer: 'Recogida por el cliente',
  requestedBy: 'Solicitado por: {name}',
  customer: 'Cliente',

  colDescription: 'DESCRIPCIÓN',
  colQuantity: 'CANT.',
  colUnitPrice: 'PRECIO',
  colNet: 'IMPORTE',
  colRate: 'TIPO',
  colTax: 'IMPUESTO',
  colLineTotal: 'TOTAL',
  // Not "exento", for the reason given on the French label.
  noRate: 'sin impuesto',
  shipmentSubtotal: 'Subtotal, {place}',

  taxableNet: 'Importe neto',
  freightTaxable: 'Transporte (sujeto a impuesto)',
  freightNotTaxable: 'Transporte (no sujeto a impuesto)',
  totalDue: 'Total a pagar',

  howToPay: 'Forma de pago',
  accountName: 'Titular de la cuenta',
  bank: 'Banco',
  bankAddress: 'Dirección',
  routingNumber: 'N.º de ruta',
  accountNumber: 'N.º de cuenta',
  iban: 'IBAN',
  bic: 'BIC',
  paymentReference: 'Concepto',

  taxJurisdiction: 'Jurisdicción fiscal {place}',
}

export const INVOICE_LABELS: Record<DocumentLanguage, InvoiceLabels> = { en, fr, es }

export function invoiceLabels(language: DocumentLanguage): InvoiceLabels {
  return INVOICE_LABELS[language]
}

/**
 * Substitute {name} placeholders. The replacement is a function so that a value
 * carrying "$&" or "$1" (a customer's own text) is printed as typed rather than
 * read as a replacement pattern.
 */
export function fillLabel(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole,
  )
}
