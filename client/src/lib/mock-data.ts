// Stationary PABs - fixed panic button installations around Singapore
export const stationaryPABs = [
  { id: "spab-001", name: "Bedok North CC", lat: 1.3282, lng: 103.9313, status: "active", address: "11 Bedok North Street 1", town: "Bedok" },
  { id: "spab-002", name: "Tampines Hub", lat: 1.3530, lng: 103.9440, status: "alert", address: "1 Tampines Walk", town: "Tampines" },
  { id: "spab-003", name: "Ang Mo Kio Hub", lat: 1.3691, lng: 103.8454, status: "active", address: "53 Ang Mo Kio Ave 3", town: "Ang Mo Kio" },
  { id: "spab-004", name: "Hougang CC", lat: 1.3612, lng: 103.8864, status: "active", address: "93 Hougang Ave 4", town: "Hougang" },
  { id: "spab-005", name: "Woodlands Civic Centre", lat: 1.4382, lng: 103.7891, status: "inactive", address: "900 South Woodlands Dr", town: "Woodlands" },
  { id: "spab-006", name: "Jurong East MRT", lat: 1.3331, lng: 103.7422, status: "active", address: "10 Jurong East St 12", town: "Jurong West" },
  { id: "spab-007", name: "Clementi CC", lat: 1.3152, lng: 103.7649, status: "alert", address: "220 Clementi Ave 4", town: "Clementi" },
  { id: "spab-008", name: "Sengkang Polyclinic", lat: 1.3917, lng: 103.8957, status: "active", address: "2 Sengkang Square", town: "Sengkang" },
  { id: "spab-009", name: "Punggol Waterway", lat: 1.4043, lng: 103.9021, status: "active", address: "10 Punggol Field", town: "Punggol" },
  { id: "spab-010", name: "Bukit Timah Plaza", lat: 1.3348, lng: 103.7760, status: "active", address: "1 Jalan Anak Bukit", town: "Bukit Timah" },
  { id: "spab-011", name: "Toa Payoh Central", lat: 1.3343, lng: 103.8494, status: "alert", address: "480 Lor 6 Toa Payoh", town: "Toa Payoh" },
  { id: "spab-012", name: "Queenstown CC", lat: 1.2966, lng: 103.8060, status: "active", address: "1 Queensway", town: "Queenstown" },
  { id: "spab-013", name: "Pasir Ris CC", lat: 1.3727, lng: 103.9494, status: "active", address: "1 Pasir Ris Dr 4", town: "Pasir Ris" },
  { id: "spab-014", name: "Geylang Serai", lat: 1.3171, lng: 103.8994, status: "active", address: "1 Geylang Serai", town: "Geylang" },
  { id: "spab-015", name: "Yishun Polyclinic", lat: 1.4304, lng: 103.8354, status: "inactive", address: "51 Yishun Ave 11", town: "Yishun" },
];

// Wearable PAB aggregates per town
export const wearablePABAggregates = [
  { town: "Bedok", lat: 1.3236, lng: 103.9273, count: 24, trend: "up" },
  { town: "Tampines", lat: 1.3530, lng: 103.9440, count: 31, trend: "stable" },
  { town: "Ang Mo Kio", lat: 1.3691, lng: 103.8454, count: 28, trend: "up" },
  { town: "Hougang", lat: 1.3612, lng: 103.8864, count: 19, trend: "stable" },
  { town: "Woodlands", lat: 1.4382, lng: 103.7891, count: 22, trend: "down" },
  { town: "Jurong West", lat: 1.3396, lng: 103.7069, count: 35, trend: "up" },
  { town: "Clementi", lat: 1.3152, lng: 103.7649, count: 14, trend: "stable" },
  { town: "Sengkang", lat: 1.3917, lng: 103.8957, count: 27, trend: "up" },
  { town: "Punggol", lat: 1.4043, lng: 103.9021, count: 18, trend: "up" },
  { town: "Bukit Timah", lat: 1.3348, lng: 103.7760, count: 11, trend: "stable" },
  { town: "Toa Payoh", lat: 1.3343, lng: 103.8494, count: 16, trend: "down" },
  { town: "Queenstown", lat: 1.2966, lng: 103.8060, count: 13, trend: "stable" },
  { town: "Pasir Ris", lat: 1.3727, lng: 103.9494, count: 20, trend: "up" },
  { town: "Yishun", lat: 1.4304, lng: 103.8354, count: 25, trend: "stable" },
];

// Conversation logs
export type ConversationPhase = "triage" | "diagnosis";
export type ConversationStatus = "active" | "resolved" | "pending";

export interface Message {
  id: string;
  sender: "senior" | "agent" | "human";
  senderName: string;
  content: string;
  timestamp: string;
}

export interface Conversation {
  id: string;
  seniorName: string;
  seniorAge: number;
  phase: ConversationPhase;
  status: ConversationStatus;
  startedAt: string;
  lastActivity: string;
  town: string;
  deviceType: "wearable" | "stationary";
  assignedTo?: string;
  messages: Message[];
}

export const conversations: Conversation[] = [
  {
    id: "conv-001",
    seniorName: "Mdm Tan Bee Leng",
    seniorAge: 74,
    phase: "triage",
    status: "active",
    startedAt: "2026-03-07T09:14:00Z",
    lastActivity: "2026-03-07T09:22:00Z",
    town: "Tampines",
    deviceType: "wearable",
    messages: [
      { id: "m1", sender: "senior", senderName: "Mdm Tan", content: "Hello? I pressed the button. I feel dizzy and my chest is tight.", timestamp: "2026-03-07T09:14:10Z" },
      { id: "m2", sender: "agent", senderName: "PAB Assistant", content: "Hello Mdm Tan, I'm here with you. Can you tell me, is this chest tightness new or have you felt this before?", timestamp: "2026-03-07T09:14:22Z" },
      { id: "m3", sender: "senior", senderName: "Mdm Tan", content: "Never like this. Started about 20 minutes ago. My arm also feels heavy.", timestamp: "2026-03-07T09:14:48Z" },
      { id: "m4", sender: "agent", senderName: "PAB Assistant", content: "I understand. These symptoms need immediate attention. I'm alerting our medical team now. Please sit or lie down and stay calm. Are you alone?", timestamp: "2026-03-07T09:15:05Z" },
      { id: "m5", sender: "senior", senderName: "Mdm Tan", content: "Yes alone. My son is at work.", timestamp: "2026-03-07T09:15:30Z" },
      { id: "m6", sender: "agent", senderName: "PAB Assistant", content: "Okay, I've flagged this as priority. A nurse will speak with you shortly. I will also try to contact your son. Please keep talking to me.", timestamp: "2026-03-07T09:15:45Z" },
      { id: "m7", sender: "human", senderName: "Nurse Priya", content: "Mdm Tan, this is Nurse Priya from the monitoring centre. I've read the conversation. Can you rate your chest pain from 1 to 10?", timestamp: "2026-03-07T09:16:20Z" },
      { id: "m8", sender: "senior", senderName: "Mdm Tan", content: "Maybe 7? It's getting worse.", timestamp: "2026-03-07T09:16:40Z" },
      { id: "m9", sender: "human", senderName: "Nurse Priya", content: "Understood. I'm dispatching an ambulance to your location now. Stay on the line with me. Do not eat or drink anything.", timestamp: "2026-03-07T09:17:00Z" },
    ],
  },
  {
    id: "conv-002",
    seniorName: "Mr Lim Chee Keong",
    seniorAge: 81,
    phase: "diagnosis",
    status: "active",
    startedAt: "2026-03-07T08:30:00Z",
    lastActivity: "2026-03-07T09:18:00Z",
    town: "Ang Mo Kio",
    deviceType: "stationary",
    assignedTo: "Dr Sarah Chua",
    messages: [
      { id: "m1", sender: "senior", senderName: "Mr Lim", content: "My blood pressure reading from this morning was 158/102. My usual medication doesn't seem to be working.", timestamp: "2026-03-07T08:30:05Z" },
      { id: "m2", sender: "agent", senderName: "PAB Assistant", content: "Good morning Mr Lim. I've noted your readings. This is on the higher side. Have you taken your medications today?", timestamp: "2026-03-07T08:30:30Z" },
      { id: "m3", sender: "senior", senderName: "Mr Lim", content: "Yes, took them at 7am. Same as always.", timestamp: "2026-03-07T08:30:55Z" },
      { id: "m4", sender: "agent", senderName: "PAB Assistant", content: "I see. I'm connecting you with Dr Chua who has your medical history.", timestamp: "2026-03-07T08:31:10Z" },
      { id: "m5", sender: "human", senderName: "Dr Sarah Chua", content: "Good morning Mr Lim. I can see your readings from the past week. Your BP has been trending upward. Did you have anything salty to eat last night?", timestamp: "2026-03-07T08:32:00Z" },
      { id: "m6", sender: "senior", senderName: "Mr Lim", content: "My daughter bought bak kut teh. Maybe I had too much.", timestamp: "2026-03-07T08:32:30Z" },
      { id: "m7", sender: "human", senderName: "Dr Sarah Chua", content: "That would do it. Sodium intake can spike BP significantly. I'm going to adjust your evening Amlodipine dose temporarily. Please monitor at 2pm and send me the reading.", timestamp: "2026-03-07T08:33:15Z" },
      { id: "m8", sender: "senior", senderName: "Mr Lim", content: "Okay doctor. Should I go to polyclinic?", timestamp: "2026-03-07T08:33:45Z" },
      { id: "m9", sender: "human", senderName: "Dr Sarah Chua", content: "Not necessary if the 2pm reading improves. Drink more water today, avoid salt. I'll check back with you this afternoon.", timestamp: "2026-03-07T08:34:20Z" },
    ],
  },
  {
    id: "conv-003",
    seniorName: "Mdm Fatimah Bte Sulaiman",
    seniorAge: 68,
    phase: "triage",
    status: "resolved",
    startedAt: "2026-03-07T07:45:00Z",
    lastActivity: "2026-03-07T08:10:00Z",
    town: "Bedok",
    deviceType: "wearable",
    messages: [
      { id: "m1", sender: "senior", senderName: "Mdm Fatimah", content: "I fell in the bathroom. I'm okay but my knee hurts a lot.", timestamp: "2026-03-07T07:45:10Z" },
      { id: "m2", sender: "agent", senderName: "PAB Assistant", content: "Mdm Fatimah, glad you're conscious. Please don't move if you feel unstable. Can you tell me if you hit your head?", timestamp: "2026-03-07T07:45:30Z" },
      { id: "m3", sender: "senior", senderName: "Mdm Fatimah", content: "No, I caught myself on the wall. Only my right knee hit the floor.", timestamp: "2026-03-07T07:45:55Z" },
      { id: "m4", sender: "agent", senderName: "PAB Assistant", content: "Good. Can you try to move your knee gently? Is it swollen?", timestamp: "2026-03-07T07:46:15Z" },
      { id: "m5", sender: "senior", senderName: "Mdm Fatimah", content: "Yes a bit swollen. Painful when I bend it.", timestamp: "2026-03-07T07:46:40Z" },
      { id: "m6", sender: "human", senderName: "Nurse Ahmad", content: "Mdm Fatimah, I'm Nurse Ahmad. Based on the details, there may be a bruise or minor fracture. Is there anyone nearby who can help you up safely?", timestamp: "2026-03-07T07:47:30Z" },
      { id: "m7", sender: "senior", senderName: "Mdm Fatimah", content: "My neighbour has a spare key. I can call her.", timestamp: "2026-03-07T07:47:55Z" },
      { id: "m8", sender: "human", senderName: "Nurse Ahmad", content: "Please do that. Don't try to get up alone. We'll follow up in 30 minutes and recommend an X-ray at Bedok Polyclinic.", timestamp: "2026-03-07T07:48:10Z" },
    ],
  },
  {
    id: "conv-004",
    seniorName: "Mr Rajan s/o Krishnan",
    seniorAge: 77,
    phase: "diagnosis",
    status: "pending",
    startedAt: "2026-03-07T09:00:00Z",
    lastActivity: "2026-03-07T09:05:00Z",
    town: "Sengkang",
    deviceType: "wearable",
    assignedTo: "Dr James Tan",
    messages: [
      { id: "m1", sender: "senior", senderName: "Mr Rajan", content: "I've been having shortness of breath when climbing stairs. It started 3 days ago.", timestamp: "2026-03-07T09:00:10Z" },
      { id: "m2", sender: "agent", senderName: "PAB Assistant", content: "Thank you for reaching out Mr Rajan. Shortness of breath lasting 3 days warrants a doctor's attention. I'm routing you to Dr Tan.", timestamp: "2026-03-07T09:00:35Z" },
      { id: "m3", sender: "human", senderName: "Dr James Tan", content: "Good morning Mr Rajan. I see you have a history of mild COPD. Is the breathlessness worse than usual, or similar to your previous episodes?", timestamp: "2026-03-07T09:02:00Z" },
      { id: "m4", sender: "senior", senderName: "Mr Rajan", content: "Worse than before. I usually can climb 2 flights. Now I can't even do one.", timestamp: "2026-03-07T09:02:40Z" },
      { id: "m5", sender: "human", senderName: "Dr James Tan", content: "I'm ordering a home spirometry test. Our nurse will be at your home by 11am. Please do not exert yourself until then.", timestamp: "2026-03-07T09:03:20Z" },
    ],
  },
  {
    id: "conv-005",
    seniorName: "Mdm Wong Siew Lian",
    seniorAge: 83,
    phase: "triage",
    status: "active",
    startedAt: "2026-03-07T09:20:00Z",
    lastActivity: "2026-03-07T09:25:00Z",
    town: "Toa Payoh",
    deviceType: "stationary",
    messages: [
      { id: "m1", sender: "senior", senderName: "Mdm Wong", content: "I feel very confused. I don't know what time it is.", timestamp: "2026-03-07T09:20:05Z" },
      { id: "m2", sender: "agent", senderName: "PAB Assistant", content: "Hello Mdm Wong, it's 9:20am. You're safe at home. Can you tell me your name for me?", timestamp: "2026-03-07T09:20:20Z" },
      { id: "m3", sender: "senior", senderName: "Mdm Wong", content: "Wong Siew Lian. Why am I so confused... my head feels strange.", timestamp: "2026-03-07T09:20:45Z" },
      { id: "m4", sender: "agent", senderName: "PAB Assistant", content: "You're doing well Mdm Wong. Sudden confusion can be serious. I'm getting medical support now. Are you sitting or lying down?", timestamp: "2026-03-07T09:21:00Z" },
      { id: "m5", sender: "senior", senderName: "Mdm Wong", content: "Sitting in my chair. My face feels funny on one side.", timestamp: "2026-03-07T09:21:30Z" },
      { id: "m6", sender: "human", senderName: "Nurse Priya", content: "Mdm Wong, I'm Nurse Priya. Based on your symptoms — confusion, facial numbness — I'm dispatching emergency services immediately. Please stay seated and keep talking to us.", timestamp: "2026-03-07T09:22:10Z" },
    ],
  },
];
