---
title: "Hosted server session (2026-10-10)"
kind: record
---

# Hosted server session (2026-10-10)

Jackson and an agent talked through what a company-hosted J5 could look like: one server, or a group of them, that people connect to, with the agents running somewhere other than a person's machine. Nothing was designed. Jackson ruled on where this sits in the order of work, and asked that the thinking be kept for later. This record is that thinking. None of it is verified against a vendor's product or a cloud service.

## What prompted it

Jackson's company is discussing how to centralise where AI runs so that it is not on people's machines. Two versions came up: the agents run in a vendor's cloud, or something starts agents on the company's own cloud, not on a standing machine, and scales them up and down.

## Where the code stood

Every agent is a program the server starts on its own machine, working in a folder on that machine's disk. Diffs, the file view, terminals, the preview browser and checkpoints all read that disk. Upstream has no agent that runs anywhere else; its Cursor documentation says Cursor's cloud agents are not configured.

## The three shapes

They differ in where an agent's files live. One server could offer more than one, as different kinds of agent.

| Shape                       | Where the agent runs                                        | What it takes                                                                                    |
| --------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| A. One big shared server    | On the server's machine, as today                           | Several members on one server. Almost nothing new about execution                                |
| B. Server as a control room | In a short-lived container the server starts for each agent | A new way to run agents, and a new answer for every feature that reads the agent's disk          |
| C. Server as a front end    | In a vendor's cloud                                         | An adapter for each vendor. A thread becomes a conversation and a pull request, with little else |

The problems a company might be solving, and which shape answers each:

| Problem                                                                       | A   | B   | C                 |
| ----------------------------------------------------------------------------- | --- | --- | ----------------- |
| Security and compliance: code and credentials off laptops                     | Yes | Yes | Yes               |
| Convenience: agents keep working when the laptop is closed                    | Yes | Yes | Yes               |
| Control: one place to see what runs, what it costs and who started it         | Yes | Yes | Partly            |
| Isolation and scale: many people's agents side by side, no machine per person | No  | Yes | Yes               |
| Cost: pay only for what runs                                                  | No  | Yes | The vendor's bill |

## Rulings

- **The target is a mix of B and C.** Which mix is not known. It has to balance the four problems and cost, and will involve compromises.
- **A is valuable on its own and is not to wait on B or C.** Share links, and several people on one server, are built for a server that runs agents the way it does today.
- **The order of work.** The first version of J5 is finishing and is being rolled out more widely. The second is the multi-player stories: several people sharing a thread, spreading Personas, Playbooks and skills around an organisation, and refining the experience. The hosted server is the third: it takes what the second version built and adds answers for enterprise concerns, which are scale, cost management and security.
- **The backend is decided after the second version exists.** What it has to carry is not known until then.

## Thinking kept for later

### Shape B: agents in containers

- **Everything that reads an agent's disk needs a new answer**: diffs, files, terminals, the preview browser and checkpoints. This is most of the work.
- **Two ways to connect a container to the server.** A small runner inside the container that the server drives, with every disk feature going through it. Or a whole single-agent J5 server inside each container, joined to the hosted server by the peering J5 already has between servers; a client already merges several servers into one view. The second reuses more and has to answer identity and sign-in for many tiny servers.
- **A short-lived container loses its disk.** The work has to live somewhere that outlasts it: a pushed branch, or a saved volume. So does the provider's own record of the conversation, or the agent cannot resume.
- **Scaling to nothing depends on resuming well.** An agent waiting on a person for a day should cost nothing, which means stopping its container and starting another when the answer arrives.
- **Containment becomes real.** An agent reaches only its own container. This is what share links were said to be waiting on: with it, a collaborate grant could be a boundary and not only a tidy view.
- **Provider sign-in.** Today an agent uses the sign-in of whoever runs the server. A hosted server has to choose between each person's own subscription and keys the organisation pays for by use. This is likely the largest cost question.

### Shape C: agents in a vendor's cloud

- **Each vendor is a provider adapter.** Adapters are upstream's, and J5 does not build them for its own features. Shape C depends on upstream adding such providers, or on a decision to diverge.
- **Agents talk to each other only if the vendor's agents can call J5's tools over the network.** Not checked for any vendor.
- **What a thread can show** is whatever the vendor reports: the conversation, and a pull request at the end. No terminal, no live file view, no checkpoints.
- **Vendor products change quickly.** A survey of what each allows is worth doing when the third version is near, not before.

### What the second version should keep open

- **Who started what.** Cost and audit on a hosted server need the person who started each thread and each agent. Nothing records that today. It is cheap to record once a session is tied to a person.
- **Identity apart from sign-in.** A person is named by whoever shares with them. A company will want its own sign-in to say who a person is. [Shared server](../product/features/shared-server.md) already keeps the person id independent of authentication, and share links should not undo that.
- **New features that read an agent's disk** add to what shape B has to replace. That is not a reason to avoid them; it is a cost to see.

## Moved, not parked

The multi-player session left one question "for the hosted-server session": what an ask means on a server with several members, where every thread can be written to by all of them. Several members on one server is shape A, which belongs to the second version. The question comes back there, not in the third.
