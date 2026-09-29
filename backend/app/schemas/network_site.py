import ipaddress

from pydantic import BaseModel, Field, field_validator, model_validator

_RFC1918_NETWORKS = tuple(ipaddress.ip_network(cidr) for cidr in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))


def normalize_private_24(value: str) -> str:
    try:
        network = ipaddress.ip_network(value, strict=True)
    except ValueError as exc:
        raise ValueError("must be a private IPv4 network-base /24") from exc
    if (
        network.version != 4
        or network.prefixlen != 24
        or not any(network.subnet_of(block) for block in _RFC1918_NETWORKS)
    ):
        raise ValueError("must be a private IPv4 network-base /24")
    return str(network)


def four_via_six_cidr(site_number: int, ipv4_cidr: str) -> str:
    network = ipaddress.ip_network(ipv4_cidr)
    packed = network.network_address.packed.hex()
    return str(
        ipaddress.ip_network(
            f"fd7a:115c:a1e0:b1a:0:{site_number:x}:{packed[:4]}:{packed[4:]}/{96 + network.prefixlen}",
            strict=False,
        )
    )


def magic_dns_hostname(site_number: int, ipv4_cidr: str, lan_ip: str) -> str:
    network = ipaddress.ip_network(ipv4_cidr)
    try:
        address = ipaddress.ip_address(lan_ip)
    except ValueError as exc:
        raise ValueError("must be an IPv4 address inside the selected network site") from exc
    if (
        address.version != 4
        or address not in network
        or address in (network.network_address, network.broadcast_address)
    ):
        raise ValueError("must be a usable IPv4 address inside the selected network site")
    return f"{str(address).replace('.', '-')}-via-{site_number}"


class NetworkSiteCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    site_number: int = Field(ge=1, le=65535)
    ipv4_cidr: str

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("must not be blank")
        return value

    @field_validator("ipv4_cidr")
    @classmethod
    def validate_ipv4_cidr(cls, value: str) -> str:
        return normalize_private_24(value)


class NetworkSiteUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    site_number: int | None = Field(default=None, ge=1, le=65535)
    ipv4_cidr: str | None = None

    @model_validator(mode="after")
    def reject_explicit_nulls(self):
        if any(getattr(self, field) is None for field in self.model_fields_set):
            raise ValueError("updated network site fields must not be null")
        return self

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value:
            raise ValueError("must not be blank")
        return value

    @field_validator("ipv4_cidr")
    @classmethod
    def validate_ipv4_cidr(cls, value: str | None) -> str | None:
        return normalize_private_24(value) if value is not None else None


class NetworkSiteSummary(BaseModel):
    id: int
    name: str
    site_number: int


class NetworkSiteResponse(NetworkSiteSummary):
    ipv4_cidr: str
    four_via_six_cidr: str
    printer_count: int
