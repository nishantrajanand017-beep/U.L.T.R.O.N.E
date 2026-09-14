import { splitTextForTTS } from "../lib/ttsChunker";

const text = `The internet operates as a vast, global network of interconnected devices, enabling data exchange between users, servers, and services. Here's a structured breakdown:  

1. Physical Infrastructure:  
Cables/Satellites: Data travels via fiber-optic cables, undersea fiber, or satellites, forming the "backbone" of the internet.  
Routers/Modems: Routers direct data between networks, while modems convert digital signals from devices (like your computer or phone) into signals compatible with internet service providers (ISPs).  

2. Communication Protocols:  
TCP/IP: The foundational protocol suite. TCP (Transmission Control Protocol) ensures data packets are delivered reliably, while IP (Internet Protocol) assigns unique addresses (IP addresses) to devices, routing data to the correct destination.  
DNS: When you type a website (e.g., google.com), the Domain Name System translates this human-readable name into an IP address (e.g., 142.250.179.174) that devices use to locate servers.  

3. Data Transmission:  
Packet Switching: Data is split into small "packets," each tagged with destination info. These packets travel independently through the network, often taking different routes, and are reassembled at the destination.  
Bandwidth: The capacity of a network connection determines how much data can be transmitted simultaneously, affecting speed and performance.  

4. Internet Service Providers (ISPs):  
ISPs (e.g., Comcast, Verizon) provide access to the internet via wired (Ethernet, fiber) or wireless (Wi-Fi, 5G) connections. They connect users to the broader internet infrastructure.  

5. Web Browsing:  
When you visit a website, your browser sends a request via HTTP/HTTPS (HyperText Transfer Protocol) to the server hosting the site. The server responds by sending data (text, images, videos) back to your device.  

6. Security & Privacy:  
SSL/TLS: Encrypts data between your browser and a website (e.g., when using HTTPS).  
Firewalls/VPNs: Protect networks by filtering traffic or masking IP addresses.  

7. Cloud Services:  
Platforms like AWS, Google Cloud, or Azure host data and applications remotely, allowing users to access services (e.g., email, apps) without local storage.  

In essence, the internet is a decentralized system where devices communicate using standardized rules, enabling seamless global connectivity. Would you like to explore any specific aspect, like cybersecurity or networking hardware?`;

const chunks = splitTextForTTS(text);
chunks.forEach((c, i) => {
  console.log(`Chunk ${i + 1} (${c.length} chars): ${JSON.stringify(c)}`);
});
