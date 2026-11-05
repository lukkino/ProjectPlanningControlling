import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api, saveBlob } from '../../api/client'
import type { ShippingAddress, ShippingContact } from '../../api/types'
import { DateInput } from '../../components/DateInput'
import { AddressBookEditor } from '../../components/tools/AddressBookEditor'
import {
  type Block,
  CAUSALI,
  LINK_COLOR,
  type Party,
  type ShippingForm,
  buildBlocks,
  copyBlocks,
  emptyParty,
} from '../../lib/shippingForm'

type Tab = 'form' | 'addresses' | 'contacts'

const contactLabel = (c: ShippingContact) => (c.company ? `${c.name} (${c.company})` : c.name)
const todayIso = () => new Date().toLocaleDateString('sv-SE')

// Indirizzo di partenza o di destinazione: dalla rubrica indirizzi (e
// persone), poi modificabile a mano.
function PartyFields({
  title,
  value,
  onChange,
  addresses,
  contacts,
}: {
  title: string
  value: Party
  onChange: (p: Party) => void
  addresses: ShippingAddress[]
  contacts: ShippingContact[]
}) {
  const [addressId, setAddressId] = useState('')
  const [contactId, setContactId] = useState('')
  const set = (field: keyof Party, v: string) => onChange({ ...value, [field]: v })
  const id = title.replace(/\W+/g, '-').toLowerCase()

  return (
    <fieldset className="shipping-party">
      <legend>{title}</legend>
      <div className="form-row">
        <label htmlFor={`${id}-book`}>Rubrica indirizzi</label>
        <select
          id={`${id}-book`}
          value={addressId}
          onChange={(e) => {
            setAddressId(e.target.value)
            setContactId('')
            const a = addresses.find((x) => String(x.id) === e.target.value)
            if (a) onChange({ company: a.company, address: a.address, contact: a.contact, email: a.email, phone: a.phone })
          }}
        >
          <option value="">— Altro (personalizza) —</option>
          {addresses.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
      </div>
      <div className="form-row">
        <label htmlFor={`${id}-company`}>Azienda / Nome *</label>
        <input id={`${id}-company`} value={value.company} onChange={(e) => set('company', e.target.value)} />
      </div>
      <div className="form-row">
        <label htmlFor={`${id}-address`}>Indirizzo</label>
        <textarea id={`${id}-address`} rows={3} value={value.address} onChange={(e) => set('address', e.target.value)} />
      </div>
      <div className="form-row">
        <label htmlFor={`${id}-people`}>Rubrica persone</label>
        <select
          id={`${id}-people`}
          value={contactId}
          onChange={(e) => {
            setContactId(e.target.value)
            const c = contacts.find((x) => String(x.id) === e.target.value)
            if (c) onChange({ ...value, contact: c.name, email: c.email, phone: c.phone })
          }}
        >
          <option value="">—</option>
          {contacts.map((c) => (
            <option key={c.id} value={c.id}>
              {contactLabel(c)}
            </option>
          ))}
        </select>
      </div>
      <div className="form-row">
        <label htmlFor={`${id}-contact`}>Persona di riferimento</label>
        <input id={`${id}-contact`} value={value.contact} onChange={(e) => set('contact', e.target.value)} />
      </div>
      <div className="shipping-two-cols">
        <div className="form-row">
          <label htmlFor={`${id}-email`}>Email</label>
          <input id={`${id}-email`} value={value.email} onChange={(e) => set('email', e.target.value)} />
        </div>
        <div className="form-row">
          <label htmlFor={`${id}-phone`}>Telefono</label>
          <input id={`${id}-phone`} value={value.phone} onChange={(e) => set('phone', e.target.value)} />
        </div>
      </div>
    </fieldset>
  )
}

// Anteprima del foglio: un riquadro bordato per blocco, come in Excel.
function Preview({ blocks, onClick }: { blocks: Block[]; onClick: () => void }) {
  return (
    <div className="shipping-preview" onClick={onClick} title="Clic per copiare negli appunti" role="button">
      {blocks.map((block, i) => (
        <div key={i} className={`shipping-preview-block${block[0]?.style === 'header' ? ' header' : ''}`}>
          {block.map((line, j) => (
            <div
              key={j}
              style={{
                fontWeight: line.style === 'header' || line.style === 'bold' ? 700 : 400,
                color: line.style === 'link' ? LINK_COLOR : undefined,
                textDecoration: line.style === 'link' ? 'underline' : undefined,
              }}
            >
              {line.text || ' '}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

// Tool Modulo Spedizioni (ex app desktop): modulo con anteprima live,
// export Excel, copia negli appunti per la mail, rubriche.
export function ShippingToolPage() {
  const [tab, setTab] = useState<Tab>('form')
  const { data: addresses = [] } = useQuery({ queryKey: ['tools-shipping-addresses'], queryFn: api.tools.shipping.addresses })
  const { data: contacts = [] } = useQuery({ queryKey: ['tools-shipping-contacts'], queryFn: api.tools.shipping.contacts })
  const sortedContacts = [...contacts].sort((a, b) => contactLabel(a).localeCompare(contactLabel(b)))

  const [form, setForm] = useState<ShippingForm>(() => ({
    mittente: emptyParty(),
    destinatario: emptyParty(),
    materiale: '',
    dimensioniPeso: '',
    causale: CAUSALI[0],
    data: todayIso(),
  }))
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const blocks = buildBlocks(form)
  const missing = !form.mittente.company.trim() || !form.destinatario.company.trim()

  const check = () => {
    setNotice(null)
    if (missing) {
      setError("Compila almeno l'azienda/nome di partenza e di destinazione.")
      return false
    }
    setError(null)
    return true
  }
  const exportFile = useMutation({
    mutationFn: () => api.tools.shipping.exportFile(blocks),
    onSuccess: ({ blob, filename }) => saveBlob(blob, filename),
    onError: (e: Error) => setError(e.message),
  })
  const copy = async () => {
    if (!check()) return
    try {
      await copyBlocks(blocks)
      setNotice('Tabella copiata negli appunti: incollala nella mail o in Excel (Ctrl+V).')
    } catch (e) {
      setError(`Copia non riuscita: ${(e as Error).message}`)
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="sub">
            <Link to="/tools">Tools</Link> ›
          </div>
          <h1>🚚 Modulo Spedizioni</h1>
        </div>
      </div>

      <div className="tabs">
        {(
          [
            ['form', 'Modulo'],
            ['addresses', `Rubrica indirizzi (${addresses.length})`],
            ['contacts', `Rubrica persone (${contacts.length})`],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'form' && (
        <div className="shipping-layout">
          <div>
            <PartyFields
              title="Indirizzo di partenza (mittente)"
              value={form.mittente}
              onChange={(mittente) => setForm((f) => ({ ...f, mittente }))}
              addresses={addresses}
              contacts={sortedContacts}
            />
            <PartyFields
              title="Indirizzo di destinazione"
              value={form.destinatario}
              onChange={(destinatario) => setForm((f) => ({ ...f, destinatario }))}
              addresses={addresses}
              contacts={sortedContacts}
            />
            <fieldset className="shipping-party">
              <legend>1. Elenco materiale da spedire</legend>
              <div className="form-row">
                <textarea
                  aria-label="Elenco materiale"
                  rows={4}
                  value={form.materiale}
                  onChange={(e) => setForm((f) => ({ ...f, materiale: e.target.value }))}
                />
              </div>
              <div className="form-row">
                <label htmlFor="ship-dimensions">Dimensioni e peso</label>
                <textarea
                  id="ship-dimensions"
                  rows={2}
                  value={form.dimensioniPeso}
                  onChange={(e) => setForm((f) => ({ ...f, dimensioniPeso: e.target.value }))}
                />
              </div>
            </fieldset>
            <div className="shipping-two-cols">
              <fieldset className="shipping-party">
                <legend>3. Causale Spedizione</legend>
                <input
                  aria-label="Causale"
                  list="ship-causali"
                  value={form.causale}
                  onChange={(e) => setForm((f) => ({ ...f, causale: e.target.value }))}
                />
                <datalist id="ship-causali">
                  {CAUSALI.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              </fieldset>
              <fieldset className="shipping-party">
                <legend>4. Data di spedizione prevista</legend>
                <DateInput aria-label="Data di spedizione" value={form.data} onChange={(data) => setForm((f) => ({ ...f, data }))} />
              </fieldset>
            </div>
          </div>

          <div className="shipping-preview-col">
            <div className="shipping-actions">
              <button className="btn btn-primary" onClick={copy}>
                📋 Copia negli appunti
              </button>
              <button className="btn" disabled={exportFile.isPending} onClick={() => check() && exportFile.mutate()}>
                ⬇ Esporta Excel
              </button>
            </div>
            {error && <div className="error-banner">{error}</div>}
            {notice && <p style={{ color: 'var(--success)', fontSize: 13, marginTop: 0 }}>{notice}</p>}
            <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
              Anteprima del foglio (clic per copiare)
            </p>
            <Preview blocks={blocks} onClick={copy} />
          </div>
        </div>
      )}

      {tab === 'addresses' && (
        <div className="card">
          <AddressBookEditor<ShippingAddress>
            entries={addresses}
            fields={[
              { key: 'label', label: 'Nome in rubrica' },
              { key: 'company', label: 'Azienda / Nome' },
              { key: 'address', label: 'Indirizzo', multiline: true },
              { key: 'contact', label: 'Persona di riferimento' },
              { key: 'email', label: 'Email' },
              { key: 'phone', label: 'Telefono' },
            ]}
            display={(a) => a.label}
            queryKey={['tools-shipping-addresses']}
            create={api.tools.shipping.createAddress}
            update={api.tools.shipping.updateAddress}
            remove={api.tools.shipping.removeAddress}
          />
        </div>
      )}

      {tab === 'contacts' && (
        <div className="card">
          <AddressBookEditor<ShippingContact>
            entries={sortedContacts}
            fields={[
              { key: 'name', label: 'Nome e cognome' },
              { key: 'company', label: 'Azienda' },
              { key: 'email', label: 'Email' },
              { key: 'phone', label: 'Telefono' },
            ]}
            display={contactLabel}
            queryKey={['tools-shipping-contacts']}
            create={api.tools.shipping.createContact}
            update={api.tools.shipping.updateContact}
            remove={api.tools.shipping.removeContact}
          />
        </div>
      )}
    </div>
  )
}
